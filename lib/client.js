window.__ModuleLoader__.load({
  id: 'dsh-file-history',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    // 图标和开关都来自官方控件集：它由 dsh.client.inject 保证在模块表里，直接取。
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    var IconClock = primitives.IconClockOutlineRegular
    var Switch = primitives.Switch
    var h = React.createElement

    var CHANNEL = '/dsh-file-history'
    var NS = 'file-history'
    var TAB_ID = 'dsh-file-history'
    // 设置命名空间就是插件在 cordis.patch.yml 里的条目 id。
    var ENTRY_ID = 'file-history'
    // 一张卡最多画多少行文件；超出的显示「还有 N 个」。
    var MAX_ROWS = 100

    // 出错时给人看的一句话：Error 用 message，其余直接转成字符串。全部落脚到这一处。
    function errText(error) {
      return String(error && error.message ? error.message : error)
    }

    // ---- 事件：轮次结束 ----------------------------------------------------------
    // 轮次结束是客户端本来就有的信号：账本里出现这一轮，就说明宿主刚写完快照。
    var turnListeners = []

    function listen(list, listener) {
      list.push(listener)
      return function () {
        var at = list.indexOf(listener)
        if (at >= 0) list.splice(at, 1)
      }
    }

    function announce(list, value) {
      var copy = list.slice()
      for (var i = 0; i < copy.length; i += 1) {
        try {
          copy[i](value)
        } catch (error) {
          console.error('[file-history] ' + errText(error))
        }
      }
    }

    function onTurnEnd(listener) { return listen(turnListeners, listener) }
    function fireTurnEnd(turn) { announce(turnListeners, turn) }

    // ---- 取数：按会话分开存 ----------------------------------------------------
    // 侧栏、输入框、轮次卡可能同时看着两个会话（刚切过会话时就是这样），共用一个格子的话，
    // 后拉到的那一份会把别人的顶掉。所以结果按会话分开，订阅者渲染时现取。
    var stores = new Map()
    var storeBusy = []
    var storePending = new Map()
    var storeReaders = []

    function publishStore(sessionId) { announce(storeReaders, sessionId) }

    // 一次取全：时间线、检查点、设置、占用，需要差异时连差异一起。带 turn 就先等这一轮落账。
    function fetchStore(call, sessionId, turn, wantDiff) {
      if (sessionId === undefined || sessionId === null || sessionId === '') return null
      var known = stores.has(sessionId) ? stores.get(sessionId) : null
      // 同一轮重复喊刷新是常态（每个视图都会收到一次轮次结束），已经反映过这一轮就不再拉。
      var needDiff = wantDiff === true || (known !== null && known.wantDiff === true)
      if (typeof turn === 'number' && known !== null && known.turn === turn && !(needDiff && known.diff === null)) return null
      if (storeBusy.indexOf(sessionId) >= 0) {
        // 拉的过程中又被叫了：只记最后一轮，拉完补一次，不叠请求。
        storePending.set(sessionId, { turn: turn, diff: needDiff })
        return null
      }
      storeBusy.push(sessionId)
      var payload = { sessionId: sessionId }
      if (typeof turn === 'number') payload.turn = turn
      if (needDiff) payload.diff = true
      return call('state', payload).then(function (value) {
        return value || {}
      }, function (error) {
        // 读失败单独标出来，列表本身沿用上一次的结果：一次抖动不该把整条历史抹掉。
        return { entries: null, notice: errText(error) }
      }).then(function (rows) {
        if (rows.entries === null || rows.entries === undefined) {
          if (known === null) return
          stores.set(sessionId, Object.assign({}, known, { notice: rows.notice }))
          publishStore(sessionId)
          return
        }
        // 只有账本里真的出现了这一轮，才把它记成「已经反映过」：等待超时时不能标，
        // 否则后面同一个轮次的刷新全被当成重复请求丢掉，列表就停在旧数据上。
        var landed = typeof turn === 'number' && (rows.entries.some(function (one) {
          return one.sessionId === sessionId && one.turn === turn
        }) || (Array.isArray(rows.blank) && rows.blank.indexOf(turn) >= 0))
        stores.set(sessionId, {
          sessionId: sessionId,
          turn: landed ? turn : null,
          entries: rows.entries,
          // 扫过但没有改动的轮次。没有快照、也没有这个记号，说明那一轮根本没扫（自动快照关着）。
          blank: Array.isArray(rows.blank) ? rows.blank : [],
          off: rows.off === true,
          auto: rows.auto !== false,
          // 两道上限都按整棵树算：树里哪条会话都能改，改的是同一个值。
          keep: typeof rows.keep === 'number' ? rows.keep : null,
          prune: typeof rows.prune === 'number' ? rows.prune : null,
          excludes: Array.isArray(rows.excludes) ? rows.excludes : [],
          allow: Array.isArray(rows.allow) ? rows.allow : [],
          // 占用只用来显示，缺字段就当没有，不参与任何判断。
          usage: rows.usage && typeof rows.usage.total === 'number' ? rows.usage : null,
          notice: rows.notice === null || rows.notice === undefined ? null : rows.notice,
          baseline: rows.baseline || null,
          baselines: Array.isArray(rows.baselines) ? rows.baselines : rows.baseline ? [rows.baseline] : [],
          // 文件被同族另一条分支推到了最新时，那一支的会话 id；没有就是 null。
          elsewhere: rows.elsewhere || null,
          // 底栏要的「当前与最新检查点的差异」；这一次没取就沿用上一份，免得闪空。
          wantDiff: needDiff,
          diff: rows.diff !== undefined && rows.diff !== null ? rows.diff : known === null ? null : known.diff
        })
        publishStore(sessionId)
      }, function () {}).catch(function () {}).then(function () {
        var at = storeBusy.indexOf(sessionId)
        if (at >= 0) storeBusy.splice(at, 1)
        var queued = storePending.has(sessionId)
        var next = storePending.get(sessionId)
        storePending.delete(sessionId)
        if (queued) fetchStore(call, sessionId, next === undefined ? undefined : next.turn, next !== undefined && next.diff === true)
      })
    }

    // 动了磁盘、动了检查点的那一方喊这里：重读这个会话的账本，再让改动条重算一次差异。
    function reloadSession(call, sessionId) {
      // 动作之后底栏要立刻重算，所以这次取数连差异一起要。
      fetchStore(call, sessionId, undefined, true)
    }

    // 视图这边只有两件事：订阅结果、在挂载时和轮次结束时统一触发一次取数。
    function useStore(call, sessionId, wantDiff) {
      var tick = React.useState(0)
      var setTick = tick[1]
      React.useEffect(function () {
        var alive = true
        function reader(id) {
          if (alive && id === sessionId) setTick(function (n) { return n + 1 })
        }
        storeReaders.push(reader)
        // 挂载时总要重读一次：账本可能在上次卸载后被别处改过，光看缓存会显示旧的行。
        fetchStore(call, sessionId, undefined, wantDiff)
        var off = onTurnEnd(function (ended) {
          fetchStore(call, sessionId, ended !== null && ended !== undefined ? ended.turn : undefined, wantDiff)
        })
        return function () {
          alive = false
          var at = storeReaders.indexOf(reader)
          if (at >= 0) storeReaders.splice(at, 1)
          off()
        }
      }, [sessionId])
      return stores.has(sessionId) ? stores.get(sessionId) : null
    }

    var CSS = [
      '.fh-card{flex:none;margin:6px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font:var(--dsw-font-xxs-12);overflow:hidden}',
      '.fh-head{display:flex;align-items:center;gap:10px;padding:6px 12px;cursor:pointer;color:var(--dsw-alias-label-secondary);user-select:none;line-height:24px}',
      '.fh-head:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.fh-title{font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-primary)}',
      // 分支提示卡是静止的一行：整头行不是按钮，别继承改动条的指针和悬停底色。
      '.fh-jump .fh-head{cursor:default}',
      '.fh-jump .fh-head:hover{background:transparent}',
      // 两张卡叠在输入框上方：外层只负责间距，视觉照旧落在各自的 .fh-card 上。
      '.fh-stack{display:flex;flex-direction:column;gap:6px}',
      '.fh-caret{flex:none;width:10px;color:var(--dsw-alias-label-tertiary)}',
      // 头行右侧的展开指示，位置与官方任务条的 chevron 一致：贴着右端、不可伸缩。
      '.fh-chevron{flex:0 0 auto;margin-left:auto;color:var(--dsw-alias-label-tertiary);line-height:24px}',
      '.fh-stat{color:var(--dsw-alias-label-tertiary)}',
      '.fh-add{color:var(--dsw-alias-state-success-primary)}',
      '.fh-del{color:var(--dsw-alias-state-error-primary)}',
      '.fh-warn{color:var(--dsw-alias-state-warn-label)}',
      '.fh-body{border-top:1px solid var(--dsw-alias-border-l1);max-height:calc(8 * (1lh + 6px));overflow:auto}',
      '.fh-row{display:flex;align-items:center;gap:8px;padding:3px 10px;color:var(--dsw-alias-label-secondary)}',
      '.fh-kind{flex:none;width:14px;text-align:center;color:var(--dsw-alias-label-tertiary)}',
      '.fh-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-primary)}',
      // 轮次卡片只留动作行：不要卡片外观，按钮就是全部内容。
      '.fh-card-actions{margin:6px 0 0;border:none;background:transparent}',
      '.fh-card-actions .fh-foot{border-top:none;padding:0}',
      // 设置内容现在是设置页里的一个 tab，标题在 tab 标签上，不再套一层可折叠卡片。
      '.fh-set-tab{display:flex;flex-direction:column}',
      '.fh-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l1)}',
      // 按钮取设置页 discard/save 那一套：13px、圆角 8、5px 14px、描边空底，悬停才提亮文字与边框。
      '.fh-btn{appearance:none;min-width:0;font:inherit;font-size:13px;line-height:1.5;white-space:nowrap;cursor:pointer;color:var(--dsw-alias-label-secondary);background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 14px;display:inline-flex;align-items:center;gap:4px}',
      '.fh-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
      '.fh-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.fh-btn:disabled{cursor:default;opacity:.4}',
      '.fh-btn-warn{color:var(--dsw-alias-state-warn-primary)}',
  '.fh-btn-warn:hover:not(:disabled){color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-interactive-bg-hover)}',
  '.fh-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-secondary)}',
  '.fh-btn-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-interactive-bg-hover))}',
  '.fh-btn-accent{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}',
  '.fh-btn-accent:hover:not(:disabled){color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover-accent,var(--dsw-alias-interactive-bg-hover))}',
  '.fh-btn-primary{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:transparent;font-weight:500}',
  '.fh-btn-primary:hover:not(:disabled){color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary));border-color:transparent}',
      '.fh-btn-end{margin-left:auto}',
      // 「当前」是自己的一格：手改出来、还没被任何轮次或检查点记下来的那一版，同样按重的处理。
      '.fh-card-now{border-color:var(--dsw-alias-border-l2);box-shadow:inset 2px 0 0 var(--dsw-alias-state-business-primary)}',
      // 设置内容现在是设置页里的一个 tab：卡片外壳与折叠头都跟旧位置一起删掉了。
      '.fh-set-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
      '.fh-set-field+.fh-set-field{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.fh-set-row{display:flex;align-items:center;gap:8px}',
      // 只读的数字靠右站，和左边的标签同一行对齐。
      '.fh-set-value{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.fh-set-label{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}',
      '.fh-set-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}',
      '.fh-set-input{display:flex;align-items:center;gap:6px}',
      '.fh-set-num{width:88px;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5;text-align:right}',
      '.fh-set-num:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
      '.fh-set-unit{flex:none;width:30px;color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.fh-note{color:var(--dsw-alias-label-tertiary)}',
      '.fh-error{color:var(--dsw-alias-state-error-primary)}',
      '.fh-ok{color:var(--dsw-alias-state-success-primary)}',
      // 面板分两段：上 2/3 是时间线，下 1/3 是配置单，各自滚各自的。
      '.fh-pane{display:flex;flex-direction:column;height:100%;box-sizing:border-box}',
      '.fh-panel{display:flex;flex-direction:column;gap:8px;padding:8px;overflow:auto;flex:1;min-height:0;box-sizing:border-box}',
      '.fh-tl-wrap{flex:1 1 auto;min-height:0;overflow:auto;padding:8px;box-sizing:border-box}',
      // 配置单按内容占高、最多半屏：flex 基准写 0 时，父容器高度不确定就会塌成 0，整块设置看不见。
      '.fh-config{flex:0 1 auto;width:100%;max-width:760px;max-height:46%;min-height:0;overflow:auto;padding:0 18px 12px;border-top:.5px solid var(--dsw-alias-border-l3);box-sizing:border-box}',
      '.fh-config .fh-set-unit{width:auto;flex:none}',
      // 一条规则一行；边框、圆角、底色跟设置页里那些输入框同一档，聚焦时才亮品牌色。
      '.fh-set-area{box-sizing:border-box;width:100%;min-height:76px;padding:8px 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5;resize:vertical}',
      '.fh-set-area:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
      '.fh-set-area::placeholder{color:var(--dsw-alias-label-tertiary)}',
      // 有没保存的改动才出这一行，排法照设置卡片的 footer：右对齐，放弃在左，保存是实心那颗。
      '.fh-set-foot{display:flex;justify-content:flex-end;align-items:center;gap:8px}',
      // 动作按钮取设置页 discard/save 那一套：13px、圆角 8、5px 14px，次要的是描边空底。
      '.fh-cbtn{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:0 0;white-space:nowrap;transition:color .16s,border-color .16s}',
      '.fh-cbtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
      '.fh-cbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.fh-cbtn:disabled{cursor:default;opacity:.4}',
      '.fh-cbtn-save{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}',
      '.fh-cbtn-save:hover:not(:disabled){color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary));border-color:transparent}',
      '.fh-cbtn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-secondary)}',
      '.fh-cbtn-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.fh-panel-empty{padding:16px 8px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);text-align:center}',
      // 侧栏可以拉得很宽，但一行信息的长度不该跟着无限拉长：正文区按设置页那一档收在 760px。
      '.fh-tl{display:flex;flex-direction:column;gap:2px;width:100%;max-width:760px}',
      // 一行只声明「普通轮次」的尺寸变量，当前节点与检查点整组覆盖这些变量，
      // 这样尺寸/字重/圆点只有一处定义，不再靠逐条后代规则去打补丁。
      '.fh-tl-row{--fh-pad:3px 8px;--fh-fs:12px;--fh-fw:500;--fh-fg:var(--dsw-alias-label-secondary);--fh-sum:11px;--fh-dot:7px;--fh-dot-top:10px;--fh-dot-left:3px;position:relative;padding-left:18px;display:flex;flex-direction:column}',
      '.fh-tl-row-current,.fh-tl-row-checkpoint{--fh-pad:8px;--fh-fs:13px;--fh-fw:600;--fh-fg:var(--dsw-alias-label-primary);--fh-sum:12px;--fh-dot:9px;--fh-dot-top:13px;--fh-dot-left:2px}',
      '.fh-tl-row:before{content:\'\';position:absolute;left:6px;top:0;bottom:-2px;width:1px;background:var(--dsw-alias-border-l2)}',
      '.fh-tl-row:first-child:before{top:calc(var(--fh-dot-top) + 4px)}',
      '.fh-tl-row:last-child:before{bottom:auto;height:calc(var(--fh-dot-top) + 4px)}',
      '.fh-tl-dot{position:absolute;left:var(--fh-dot-left);top:var(--fh-dot-top);width:var(--fh-dot);height:var(--fh-dot);border-radius:50%;box-sizing:border-box;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3)}',
      '.fh-tl-dot-now{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}',
      '.fh-tl-dot-origin{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.fh-tl-dot-fork{background:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
      '.fh-tl-dot-manual{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary)}',
      // 父分支的轮次只能在文件上还原，对话动不了：圆点大小和颜色都不变，外面套一圈虚线圈表示「隔了一层」。
      '.fh-tl-dot>i{position:absolute;left:-3px;top:-3px;right:-3px;bottom:-3px;border-radius:50%;border:1px dashed var(--dsw-alias-label-secondary);box-sizing:border-box;pointer-events:none}',
      // 时间线上一行就是一条记录：左侧时间、中间标题与摘要、右侧增删。悬停才浮出底色，不做成按钮块。
      // 一行三块：时间、标题、摘要+增删。窄的时候标题先让位，宽的时候摘要跟着长，不留大空洞。
      '.fh-node{display:flex;align-items:center;gap:10px;min-width:0;padding:var(--fh-pad);border-radius:8px;cursor:pointer}',
      '.fh-tl-row .fh-panel-empty{text-align:left;padding:4px 8px}',
      '.fh-node:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.fh-node-time{flex:none;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;font-variant-numeric:tabular-nums}',
      '.fh-node-title{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fh-fg);font-size:var(--fh-fs);font-weight:var(--fh-fw);line-height:20px}',
      '.fh-node-sum{min-width:0;flex:auto;color:var(--dsw-alias-label-tertiary);font-size:var(--fh-sum);line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.fh-node-stat{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;display:inline-flex;gap:6px}',
      // 父分支的轮次整行压暗一档，和本线自己的轮次分开。
      '.fh-tl-row-foreign .fh-node-title{color:var(--dsw-alias-label-tertiary)}',
      '.fh-tl-row-foreign .fh-node-time,.fh-tl-row-foreign .fh-node-sum,.fh-tl-row-foreign .fh-node-stat{opacity:.6}',
      '.fh-tl-row .fh-card{margin:2px 0 6px}',
      '.fh-tl-row-note .fh-node{cursor:default;padding:4px 8px}',
      '.fh-tl-row-note .fh-node:hover{background:transparent}',
      '.fh-tl-row-note .fh-node-title{color:var(--dsw-alias-label-tertiary);font-weight:400}',
      // 尺寸只有两档，但「档」不等于「节点类型」：当前停在哪一格，哪一格就按重的那档画。
      // 「当前」是贴在节点上的指针标签，不是另一个节点。
      '.fh-node-now{flex:none;margin-left:-2px;padding:0 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:20px}',
      '.fh-time{margin-left:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-tertiary)}',
      '.fh-card>.fh-error,.fh-card>.fh-ok,.fh-card>.fh-warn{padding:0 10px 6px}',
      '.fh-turn{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-tertiary)}',
      // 宽度照官方 TodoPanel 的算法：100% 减去两侧 side-clearance 与四份 dock-inset，
      // 封顶 card-max-width 减四份 dock-inset，居中。内边距也照它交给正文容器，
      // 这样窄屏时和输入框卡片一起收缩，不会比它宽出一截。
      '.fh-base{box-sizing:border-box;flex:0 0 auto;margin:0 auto;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));border-width:.5px;border-radius:12px;background:var(--dsw-specific-tip);overflow:hidden}',
      // 正文容器与官方 TodoPanel 的 body 同一套：6px 12px 内边距、列向 8px 间距。
      '.fh-base>.fh-head,.fh-base>.fh-body,.fh-base>.fh-foot,.fh-base>.fh-note{padding-left:12px;padding-right:12px}'
    ].join('')

    var ZH = {
      title: '本轮改动',
      panelTitle: '文件历史',
      panelDesc: '逐轮列出改动的文件，可还原文件或对话',
      turnLabel: '第',
      turnUnit: '轮',
      empty: '还没有记录',
      files: '个文件',
      skipped: '跳过',
      binary: '二进制',
      more: '还有',
      gitMissing: '文件历史不可用：找不到 git 2.20 或更高版本',
      pruneNote: '已清理更早的',
      outsideAsk: '个文件在记录之后被外面改过，仍要覆盖？',
      outsideAskTurn: '个文件在这一轮之后被外面改过，仍要覆盖？',
      overwrite: '仍要还原',
      autoLabel: '每轮自动拍快照',
      autoHint: '关掉后只在点「设为检查点」时记录：没有逐轮的卡片和时间线行，只能还原到检查点。',
      offLabel: '对整棵会话树启用文件历史',
      offHint: '管的是这棵树里的每一条会话：关掉只停以后，已经记下来的轮次照旧在列表里，能看也能还原。',
      excludeLabel: '排除规则',
      excludeNone: '一条都没有',
      excludeHint: '一行一条，只写路径；这里改的只对这一棵树生效，改完点保存。',
      allowLabel: '允许规则',
      allowNone: '不填就全记',
      allowHint: '一行一条，只写路径；不填就记全部，填了只记这里列出的。排除规则仍然生效。',
      usageLabel: '占用空间',
      usageHint: '这一棵树记下的轮次与检查点占用；清理入口在下面，也只动这一棵树。',
      diffTitle: '相对上个检查点',
        offNote: '文件历史已关闭，下面保留的是关闭前的记录。',
      revertFiles: '还原文件到此处',
      revertChat: '还原会话到此处',
      revertBoth: '还原文件和会话',
      branch: '从此处分支',
      undo: '撤销此轮更改',
      confirmFiles: '把文件退回这一轮结束时的样子？之后改过的会被覆盖。',
      confirmChat: '把对话退回这一轮结束的位置？会新建一个会话，这个会话留着。',
      confirmBoth: '文件退回这一轮结束时的样子，对话退回这一轮结束的位置？',
      confirm: '还原',
      cancel: '取消',
      working: '处理中…',
      filesDone: '文件已还原',
      chatDone: '对话已还原，已切换到新会话',
      bothDone: '文件和对话都已还原，原会话收进了归档（侧栏筛选切到归档可见）',
      archiveFailed: '原会话正忙，没能归档，仍在侧栏里',
      branchDone: '分支开好了，已切换到新会话',
      undoDone: '已撤销这一轮',
      written: '写入',
      removed: '删除',
      // 界面上一律叫「检查点」，代码里的 baseline 是同一个东西的旧名。
      baseline: '检查点',
      dockSet: '设为新的检查点',
    dockRevert: '还原到上个检查点',
    baselineNew: '设为检查点',
    deletePoint: '删除检查点',
    deletePointAsk: '删除这个检查点？',
    pointDropped: '已删除检查点',
      baselineConfirm: '把文件还原到检查点？当前改动会被覆盖。',
      baselineDone: '已还原到检查点',
      now: '当前',
      nowHint: '当前工作区',
      baselineSavedHint: '保留的那一版',
      baselineOlderHint: '早一些的那一版',
      baselineOriginHint: '会话开始时的样子',
      baselineForkHint: '分支从这里出去',
      nowBody: '这是磁盘上的现状，还没有被任何一轮或检查点记下来。',
      baselineSaved: '已设为检查点',
      baselineNoChange: '这一版已经是最新检查点',
      clearTurns: '清除轮次快照',
      clearAll: '清除所有分支历史',
      clearTurnsConfirm: '清除这条线上所有分支的轮次快照？根节点和分支节点都会留下。',
      clearAllConfirm: '清除这条线上所有分支的轮次和检查点？',
      clearGo: '清除',
      capped: '按规模上限降级',
      tooBig: '太大没记：',
      crossLineHint: '父分支的轮次只能查看，要动它请从上方那张卡跳过去',
      elsewhereTitle: '文件现在停在另一条分支上',
      elsewhereGo: '跳转到该分支',
      setTurnCard: '轮次卡片',
      setDock: '改动条',
      setTimeline: '侧栏时间线',
      setKeep: '保留最近轮次',
      setFileSize: '单个文件上限',
      setRepoFiles: '单个仓库文件数',
      setTotal: '快照总量上限',
      hintTurnCard: '每轮对话结束，在那条回复下面列出改动的文件。',
      hintDock: '输入框上方那条提示，只在工作区和检查点有差别时出现。',
      hintTimeline: '右侧栏里把轮次和检查点排成一条线。',
      hintKeep: '最近这么多轮要留着；但不能早于「检查点后清理到」那条线，两个都满足才留下。0 表示不按轮次裁。',
      hintKeepDefault: '新会话树的默认值；每一棵树都能在侧栏里单独改。',
      hintFileSize: '超过这个大小的文件不记内容，只在卡片里标出来。',
      hintRepoFiles: '单个内嵌的仓库文件比这多，就整块跳过。',
      hintTotal: '快照总共占多少盘，超了先清最旧的轮次。',
      hintPrune: '凑够这么多个检查点时，倒数第 N 个之前的轮次删掉；最近多少轮那条线照样要满足。0 表示不按检查点裁。',
      hintPruneDefault: '新会话树的默认值；每一棵树都能在侧栏里单独改。',
      setPrune: '检查点后清理到',
      setUnitTurn: '轮',
      setUnitPiece: '个',
      setUnitMB: 'MB',
      saveFailed: '没存上',
      saveGo: '保存'
    }

    var EN = {
      title: 'Changes this turn',
      panelTitle: 'File history',
      panelDesc: 'Files changed per turn, revert files or chat',
      turnLabel: 'Turn',
      turnUnit: '',
      empty: 'Nothing recorded yet',
      files: 'files',
      skipped: 'skipped',
      binary: 'binary',
      more: 'more',
      gitMissing: 'File history unavailable: git 2.20 or newer was not found',
      pruneNote: 'Cleared',
      outsideAsk: 'files changed outside since the last snapshot; overwrite anyway?',
      outsideAskTurn: 'files changed outside since this turn; overwrite anyway?',
      overwrite: 'Overwrite',
      autoLabel: 'Snapshots every turn',
      autoHint: 'Off records only when you press Set checkpoint: no per-turn cards or timeline rows, and you can only restore to checkpoints.',
      offLabel: 'File history for the whole tree',
      offHint: 'Applies to every session in this tree: off only stops new snapshots, and recorded turns stay restorable.',
      excludeLabel: 'Excluded paths',
      excludeNone: 'None',
      excludeHint: 'One rule per line, paths only; these apply to this session tree and take effect when saved.',
      allowLabel: 'Only these paths',
      allowNone: 'Empty records everything',
      allowHint: 'One rule per line, paths only; empty records everything, otherwise only what is listed. Excluded paths still apply.',
      usageLabel: 'Disk usage',
      usageHint: 'Space taken by this session tree; the clean-up entries below affect only this tree.',
      diffTitle: 'Since last checkpoint',
        offNote: 'File history is off; the records below stay as they were.',
      revertFiles: 'Restore files to here',
      revertChat: 'Restore conversation to here',
      revertBoth: 'Restore files and conversation',
      branch: 'Branch from here',
      undo: 'Undo this turn\'s changes',
      confirmFiles: 'Put the files back to how they were at the end of this turn? Later changes are overwritten.',
      confirmChat: 'Rewind the conversation to the end of this turn? A new session is created and this one stays.',
      confirmBoth: 'Put files back to the end of this turn and rewind the conversation to it?',
      confirm: 'Confirm',
      cancel: 'Cancel',
      working: 'Working…',
      filesDone: 'Files restored',
      chatDone: 'Chat rewound, switched to the new session',
      bothDone: 'Files and chat restored; the previous session is in the archive (switch the sidebar filter to see it)',
      archiveFailed: 'The previous session was busy, so it stayed in the sidebar',
      branchDone: 'Branch created, switched to the new session',
      undoDone: 'Turn undone',
      written: 'written',
      removed: 'removed',
      baseline: 'Checkpoint',
      dockSet: 'Set a new checkpoint',
    dockRevert: 'Restore to last checkpoint',
    baselineNew: 'Set as checkpoint',
    deletePoint: 'Delete checkpoint',
    deletePointAsk: 'Delete this checkpoint?',
    pointDropped: 'Checkpoint deleted',
      baselineConfirm: 'Restore files to the checkpoint? Current changes will be overwritten.',
      baselineDone: 'Files restored to the checkpoint',
      now: 'Now',
      nowHint: 'Current workspace',
      baselineSavedHint: 'Snapshot of that moment',
      baselineOlderHint: 'The earlier one',
      baselineOriginHint: 'How it looked when the session began',
      baselineForkHint: 'The branch left from here',
      nowBody: 'This is what is on disk now; no turn or checkpoint has recorded it yet.',
      baselineSaved: 'Saved as checkpoint',
      baselineNoChange: 'Already the latest checkpoint',
      clearTurns: 'Clear turn snapshots',
      clearAll: 'Clear all branch history',
      clearTurnsConfirm: 'Clear turn snapshots on every branch of this line? Root and branch checkpoints stay.',
      clearAllConfirm: 'Clear turns and checkpoints on every branch of this line?',
      clearGo: 'Clear',
      capped: 'Recorded short of the size cap',
      tooBig: 'Too large to record:',
      crossLineHint: 'Turns from a parent branch are read-only — jump to that branch to change anything',
      elsewhereTitle: 'The files now sit on another branch',
      elsewhereGo: 'Go to that branch',
      setTurnCard: 'Turn card',
      setDock: 'Change bar',
      setTimeline: 'Sidebar timeline',
      setKeep: 'Keep recent turns',
      setFileSize: 'Max file size',
      setRepoFiles: 'Max files per repository',
      setTotal: 'Max snapshot size',
      hintTurnCard: 'Lists the changed files under each reply, once the turn ends.',
      hintDock: 'The bar above the input, shown only when the workspace differs from the checkpoint.',
      hintTimeline: 'Turns and checkpoints as one line in the sidebar.',
      hintKeep: 'The newest turns are kept, but never one older than the prune checkpoint; both limits must hold. 0 disables the turn limit.',
      hintKeepDefault: 'Default for new session trees; each tree can change it from the sidebar.',
      hintFileSize: 'Files larger than this are listed but not stored.',
      hintRepoFiles: 'An embedded repository with more files than this is skipped whole.',
      hintTotal: 'Disk the snapshots may use; the oldest turns go first.',
      hintPrune: 'Once the tree has this many checkpoints, turns older than the Nth newest go, even if they are recent. 0 disables this limit.',
      hintPruneDefault: 'Default for new session trees; each tree can change it from the sidebar.',
      setPrune: 'Prune to checkpoint',
      setUnitTurn: 'turns',
      setUnitPiece: 'files',
      setUnitMB: 'MB',
      saveFailed: 'Not saved',
      saveGo: 'Save'
    }

    // ---- 小工具 ----------------------------------------------------------------
    // 占用只报一个数：小于 1 MB 按 KB 算，免得一直显示 0.0 MB。
    function sizeText(bytes) {
      if (typeof bytes !== 'number' || bytes <= 0) return ''
      if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB'
      if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
      return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB'
    }

    function timeText(time) {
      if (typeof time !== 'number' || time <= 0) return ''
      var date = new Date(time)
      return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
    }

    // 设置单里的一行：标签在左、控件在右，说明在下面一行。
    function setRow(label, control) {
      return h('div', { className: 'fh-set-row' }, h('span', { className: 'fh-set-label' }, label), control)
    }

    function setHint(text) {
      return h('p', { className: 'fh-set-hint' }, text)
    }

    function setField(key, children) {
      return h('div', { key: key, className: 'fh-set-field' }, children)
    }

    // ---- 轮次动作行 ------------------------------------------------------------
    // 改动的文件清单和 diff 已经由官方的轮次卡负责，这里只放动作，不重复列一遍。
    // 默认（非 bare）也用来画时间线展开后的那一格：检查点行、「当前」行共用这一套结构。
    // 一行改动：A/M/D 一个字母、路径、增删数（二进制只写「二进制」）。三处列表共用。
    function changeRow(t, change, flat) {
      return h('div', { key: change.path, className: 'fh-row' + (flat ? ' fh-row-flat' : '') },
        h('span', { className: 'fh-kind' }, change.kind === 'added' ? 'A' : change.kind === 'deleted' ? 'D' : 'M'),
        h('span', { className: 'fh-path' }, change.path),
        change.binary
          ? h('span', { className: 'fh-stat' }, t('binary'))
          : h('span', { className: 'fh-stat' },
              h('span', { className: 'fh-add' }, '+' + change.additions), ' ',
              h('span', { className: 'fh-del' }, '-' + change.deletions)))
    }

    // 增删汇总：文件数、加、减。卡头与差异条都要这一组。
    function statsSpans(t, stats) {
      return [
        h('span', { key: 'count', className: 'fh-stat' }, stats.files + ' ' + t('files')),
        h('span', { key: 'add', className: 'fh-add' }, '+' + stats.additions),
        h('span', { key: 'del', className: 'fh-del' }, '-' + stats.deletions)
      ]
    }

    // 一次性反馈（存上了、没存上）用同一行，颜色按语气分。
    function noticeLine(notice) {
      if (notice === null || notice === undefined) return null
      var tone = notice.tone === 'error' ? 'fh-error' : notice.tone === 'warn' ? 'fh-warn' : 'fh-ok'
      return h('div', { className: tone }, notice.text)
    }

    // 设检查点之后要说的话：存上了没有、顺手裁掉了几轮。三个入口共用这一份。
    function checkpointNotice(t, value) {
      var skipped = value !== null && value !== undefined && value.skipped === true
      var pruned = value !== null && value !== undefined && value.pruned > 0 ? value.pruned : 0
      // 这一版已经是最新检查点时什么也没存下，说「已设为检查点」就是假的。
      var saved = skipped ? t('baselineNoChange') : t('baselineSaved')
      return { tone: skipped ? 'warn' : 'ok', text: pruned > 0 ? saved + ' · ' + t('pruneNote') + ' ' + pruned + ' ' + t('setUnitTurn') : saved }
    }

    // 每个「先问一句再动手」的地方都是同一排：一句说明、一颗确认、一颗取消。
    function confirmBar(t, busy, askText, yesLabel, onYes, onNo) {
      return [
        h('span', { key: 'ask', className: 'fh-note' }, askText),
        h('button', { key: 'yes', className: 'fh-btn fh-btn-warn', disabled: busy, onClick: onYes }, busy ? t('working') : yesLabel),
        h('button', { key: 'no', className: 'fh-btn', disabled: busy, onClick: onNo }, t('cancel'))
      ]
    }

    function Entry(props) {
      var t = props.t
      var call = props.call
      var entry = props.entry
      var sessionId = props.sessionId
      var uiWorkspace = props.uiWorkspace
      var onChanged = props.onChanged || function () {}
      var headTitle = props.headTitle || t('title')
      // 撤销的意思是「把这一轮改的东西退回去」：这一轮没有改动，这个动作就没有意义，
      // 哪怕账本里还留着可退的 base。
      var undoable = props.undo === true && Array.isArray(entry.changes) && entry.changes.length > 0
      // 手动设的点能删、能从它分支；开头点和分支点本身不是某一轮，两样都不给。
      var manual = props.manual === true
      // 「当前」行只是指针，检查点行只做「还原到检查点」一件事：两者都不出现轮次的那些动作。
      var pointer = props.pointer === true
        // 时间线上会露出父分支的轮次：这一行属于哪条线，还原时就去哪条线找那一轮。
      var rowLine = typeof props.rowSessionId === 'string' && props.rowSessionId !== '' ? props.rowSessionId : sessionId
      var crossLine = rowLine !== sessionId
      var timeLabel = typeof props.timeLabel === 'string' ? props.timeLabel : ''
      // 侧栏里一行默认收起，按钮等展开后再出现，免得每行都挂三个按钮。
      var footOnOpen = props.footOnOpen === true
      var listState = React.useState(props.openByDefault === true)
      var showList = listState[0]
      var setShowList = listState[1]
      var pendingState = React.useState(null)
      var pending = pendingState[0]
      var setPending = pendingState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      // 记录之后磁盘被外面改过时，先把这个数摆出来问一句，再决定要不要盖。
      var outsideState = React.useState(null)
      var outside = outsideState[0]
      var setOutside = outsideState[1]
      var noticeState = React.useState(null)
      var notice = noticeState[0]
      var setNotice = noticeState[1]
      var stats = entry.stats

      // force 只有用户被问过、按了「仍要还原」才是 true。
      async function run(kind, force) {
        setBusy(true)
        setNotice(null)
        try {
          var value
          // 还原、分支、撤销都是「把工作区写回某一版」，走同一个端点，只把「动什么」传过去。
          if (kind === 'drop') value = await call('point', { sessionId: sessionId, action: 'delete', tree: props.tree })
          else value = await call('restore', { sessionId: rowLine, turn: entry.turn, tree: props.tree, mode: kind, force: force === true })
          // 外面改过还没确认：停在问句上，磁盘一个字节都没动。
          if (value !== null && value !== undefined && value.confirm > 0) {
            setOutside({ count: value.confirm, kind: kind })
            return
          }
          setOutside(null)
          if (value.childSessionId !== undefined && uiWorkspace) uiWorkspace.openSession(value.childSessionId)
          if (kind === 'drop') {
            setNotice({ tone: 'ok', text: t('pointDropped') })
            setPending(null)
            onChanged()
            return
          }
          var text = kind === 'undo' ? t('undoDone')
            : kind === 'chat' ? t('chatDone')
              : kind === 'both' ? t('bothDone')
                : kind === 'branch' ? t('branchDone')
                  : t('filesDone')
          if (kind !== 'chat') text += ' · ' + t('written') + ' ' + value.written + ' · ' + t('removed') + ' ' + value.removed
          // 归档是「还原文件和会话」的一部分：没做成要说出来，否则侧栏里莫名多一条旧会话。
          if (kind === 'both' && value.archived === false) text += ' · ' + t('archiveFailed')
          setNotice({ tone: 'ok', text: text })
          setPending(null)
          onChanged()
        } catch (error) {
          setNotice({ tone: 'error', text: errText(error) })
        } finally {
          setBusy(false)
        }
      }

      // 把这一轮的状态存成检查点。设完会顺手裁掉更早的轮次，裁了几轮就说几轮。
      async function saveCheckpoint() {
        setBusy(true)
        setNotice(null)
        try {
          // 这一行的树属于这一轮：位置也按这一轮报，别让旧轮次的树带上当前轮次的位置。
          var value = await call('point', { sessionId: sessionId, action: 'set', tree: entry.tree, turn: entry.turn, seq: entry.endSeq })
          setNotice(checkpointNotice(t, value))
          onChanged()
        } catch (error) {
          setNotice({ tone: 'error', text: errText(error) })
        } finally {
          setBusy(false)
        }
      }

      // 降级是这一轮的额外事实：记录得不全，得让人看见，否则会当成那一轮什么都没改。
      var notes = []
      if (entry.skipped > 0) notes.push(h('span', { key: 'skip', className: 'fh-note' }, t('skipped') + ' ' + entry.skipped))
      if (entry.capped > 0) notes.push(h('span', { key: 'capped', className: 'fh-note' }, t('capped')))
      // 太大的仓库整块没进快照，得点名说是哪几个目录，不然里面的改动缺席得毫无痕迹。
      if (entry.repos && entry.repos.length > 0) notes.push(h('span', { key: 'repos', className: 'fh-note' }, t('tooBig') + ' ' + entry.repos.join('、')))

      var rows = []
      var head = []
      if (props.bare !== true) {
        var shown = entry.changes.slice(0, MAX_ROWS)
        for (var i = 0; i < shown.length; i += 1) rows.push(changeRow(t, shown[i], false))
        if (entry.changes.length > MAX_ROWS) {
          rows.push(h('div', { key: '#more', className: 'fh-row fh-note' }, t('more') + ' ' + (entry.changes.length - MAX_ROWS)))
        }
        // 「当前」没有文件列表可看：展开后只需要一句话。
        if (pointer && rows.length === 0) {
          rows.push(h('div', { key: '#note', className: 'fh-row fh-note' }, t('nowBody')))
        }
        head = [
          h('span', { key: 'caret', className: 'fh-caret' }, showList ? '▾' : '▸'),
          h('span', { key: 'title', className: 'fh-title' }, headTitle)
        ].concat(statsSpans(t, stats)).concat(notes)
        if (timeLabel !== '') head.push(h('span', { key: 'time', className: 'fh-time' }, timeLabel))
      }

      var footer = []
      if (outside !== null) {
        // 外面改过的文件比确认还原本身更该先拦一下：先答这一句，再谈还原。
        // 轮次卡的比对范围是这一轮之后，底栏与检查点是整个检查点之后，问法跟着变。
        var askText = outside.count + ' ' + (pointer || props.checkpoint === true ? t('outsideAsk') : t('outsideAskTurn'))
        footer = confirmBar(t, busy, askText, t('overwrite'),
          function () { run(outside.kind, true) },
          function () { setOutside(null); setPending(null) })
      } else if (pointer) {
        // 「当前」行只说明现在和检查点差多少，还原的入口在检查点那一行。
      } else if (pending === null) {
        // 父分支的轮次是只读的：快照虽然是同一棵，但线不在这里，要动它先跳过去。
        footer.push(h('button', { key: 'files', className: 'fh-btn', disabled: busy || crossLine, onClick: function () { setPending('files') } }, t('revertFiles')))
        footer.push(h('button', { key: 'chat', className: 'fh-btn', disabled: busy || crossLine, onClick: function () { setPending('chat') } }, t('revertChat')))
        footer.push(h('button', { key: 'both', className: 'fh-btn fh-btn-accent', disabled: busy || crossLine, onClick: function () { setPending('both') } }, t('revertBoth')))
        // 撤销的是「这一轮带来的改动」，落在上一轮的版本上，排在还原之后、开分支之前。
        // 撤销也只动自己这条线：父分支的行跟其它动作一样灰着。
        if (undoable) footer.push(h('button', { key: 'undo', className: 'fh-btn fh-btn-warn', disabled: busy || crossLine, onClick: function () { run('undo') } }, t('undo')))
        // 开分支不改这条线的任何记录，所以不用问，点了就走。
        if (props.checkpoint !== true || manual) footer.push(h('button', { key: 'branch', className: 'fh-btn', disabled: busy || crossLine, onClick: function () { run('branch') } }, t('branch')))
        if (crossLine) footer.push(h('span', { key: 'line', className: 'fh-note' }, t('crossLineHint')))
        if (manual) footer.push(h('button', { key: 'drop', className: 'fh-btn fh-btn-end fh-btn-danger', disabled: busy || crossLine, onClick: function () { setPending('drop') } }, t('deletePoint')))
      } else if (pending === 'drop') {
        footer = confirmBar(t, busy, t('deletePointAsk'), t('confirm'),
          function () { run('drop') },
          function () { setPending(null) })
      } else {
        footer = confirmBar(t, busy, pending === 'files' ? t('confirmFiles') : pending === 'chat' ? t('confirmChat') : t('confirmBoth'), t('confirm'),
          function () { run(pending) },
          function () { setPending(null) })
      }
      // 轮次行上可以顺手把这一轮存成检查点；「当前」与检查点行没有这层含义。
      // 会话关掉之后也没有：设不了新点，按钮留着只会点了报错。
      if (pending === null && !pointer && props.off !== true && props.checkpoint !== true) {
        footer.push(h('button', { key: 'baseline', className: 'fh-btn fh-btn-end', disabled: busy || crossLine, onClick: saveCheckpoint }, t('baselineNew')))
      }


      // 三类卡片共用一套行结构，外观各按用途给：轮次是记录、检查点是被留下的那一版、当前是对照。
      var cardClass = 'fh-card' + (pointer ? ' fh-card-now' : ' fh-card-turn')
      var footClass = 'fh-foot'
      // bare：轮次卡片只剩动作行，头行与文件清单都不画——那是官方轮次卡的地盘。
      if (props.bare === true) {
        if (footer.length === 0 && notes.length === 0 && notice === null) return null
        return h('div', { className: cardClass + ' fh-card-actions' },
          notes.length === 0 ? null : h('div', { className: 'fh-foot' }, notes),
          footer.length === 0 ? null : h('div', { className: 'fh-foot' }, footer),
          noticeLine(notice))
      }
      return h('div', { className: cardClass },
        h('div', { className: 'fh-head', onClick: function () { setShowList(!showList) } }, head),
        showList ? h('div', { className: 'fh-body' }, rows) : null,
        footer.length === 0 || (footOnOpen && !showList && pending === null) ? null : h('div', { className: footClass }, footer),
        noticeLine(notice))
    }

    // 检查点相关的两颗按钮只写一遍：输入框上方的差异条和侧栏的检查点行都从这里取。
    function baseFooter(props) {
      var t = props.t
      var changed = props.changed === true
      var busy = props.busy === true
      // 外面改过的文件比确认还原本身更该先拦一下：先答这一句，再谈还原。
      if (props.outside !== null && props.outside !== undefined) {
        return confirmBar(t, busy, props.outside.count + ' ' + t('outsideAsk'), t('overwrite'),
          function () { props.run(props.outside.action, true) },
          function () { props.setOutside(null); props.setAsk(null) })
      }
      if (props.pending === true) {
        return confirmBar(t, busy, t('baselineConfirm'), t('confirm'),
          function () { props.run(props.ask) },
          function () { props.setAsk(null) })
      }
      var bar = []
      if (changed) {
        // 「设为新的检查点」把这会儿的差异收进检查点，磁盘不动；「还原到上个检查点」反过来，把磁盘拉回检查点。
        bar.push(h('button', { key: 'set', className: 'fh-btn fh-btn-primary', disabled: busy, onClick: function () { props.run('set') } }, t('dockSet')))
        bar.push(h('button', { key: 'revert', className: 'fh-btn fh-btn-accent', disabled: busy, onClick: function () { props.setAsk('revert') } }, t('dockRevert')))
      }
      return bar
    }

    // ---- 输入框上方：相对上个检查点的差异 --------------------------------------
    // 输入框上方这一格在新建会话页也会被渲染，那时宿主给不出会话。外层只做取舍、不碰 hooks：
    // 里面那层才带状态，切进来才挂载，hooks 从头数一遍。
    function Baseline(props) {
      var sessionId = props.sessionId
      if (sessionId === undefined || sessionId === null || sessionId === '') return null
      return h(BaselinePane, props)
    }

    function BaselinePane(props) {
      var t = props.t
      var call = props.call
      var sessionId = props.sessionId
      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var askState = React.useState(null)
      var ask = askState[0]
      var setAsk = askState[1]
      // 记录之后磁盘被外面改过时，先把个数摆出来问一句，不让点一下就把手改盖掉。
      var outsideState = React.useState(null)
      var outside = outsideState[0]
      var setOutside = outsideState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var noticeState = React.useState(null)
      var notice = noticeState[0]
      var setNotice = noticeState[1]
      // 差异、检查点、文件停在哪条分支，都是同一份取数里的东西：底栏只是要得比别人多一样。
      var store = useStore(call, sessionId, true)
      var diff = store === null ? null : store.diff

      // force 只有用户在被问过之后按「仍要还原」时才是 true：那时候外面改过的文件是认下的。
      async function run(action, force) {
        setBusy(true)
        setNotice(null)
        try {
          // 两个动作走同一个端点：设点（set）与还原到最新检查点（revert）。
          var value = await call('point', { sessionId: sessionId, action: action, force: force === true })
          // 外面改过还没确认：停在问句上，磁盘一个字节都没动。
          if (value !== null && value !== undefined && value.confirm > 0) {
            setOutside({ count: value.confirm, action: action })
            setBusy(false)
            return
          }
          setOutside(null)
          if (action === 'revert') {
            setNotice({ tone: 'ok', text: t('baselineDone') + ' · ' + t('written') + ' ' + value.written + ' · ' + t('removed') + ' ' + value.removed })
          } else {
            setNotice(checkpointNotice(t, value))
          }
          setAsk(null)
          reloadSession(call, sessionId)
        } catch (error) {
          setNotice({ tone: 'error', text: errText(error) })
        }
        setBusy(false)
      }

      // 文件已经被同族另一条分支改走：本线的差异条说的是旧位置，先把这件事指出来，
      // 按钮直接跳过去——分支就是会话，跳转不动磁盘。
      // 关掉文件历史是这条会话的总开关：底栏整条不出现，连「文件在别的分支上」那张卡也不该留着。
      if (store !== null && store !== undefined && store.off === true) return null
      var jump = store === null || store === undefined || !store.elsewhere ? null : store.elsewhere
      var jumpCard = jump === null ? null : h('div', { className: 'fh-card fh-base fh-jump' },
        h('div', { className: 'fh-head' },
          h('span', { key: 'title', className: 'fh-title' }, t('elsewhereTitle')),
          h('button', { key: 'go', className: 'fh-btn fh-btn-end', onClick: function () { if (props.uiWorkspace) props.uiWorkspace.openSession(jump.sessionId) } }, t('elsewhereGo'))))

      if (diff === null) return jumpCard
      // 宿主说什么就显示什么：一句笼统的提示会连真正的原因一起藏掉。
      if (diff.notice !== null && diff.notice !== undefined) {
        return h('div', { className: 'fh-card fh-base' }, h('div', { className: 'fh-head fh-warn' },
          h('span', { className: 'fh-title' }, diff.notice === 'git-unavailable' ? t('gitMissing') : String(diff.notice))))
      }

      var stats = diff.stats
      var hasBase = diff.baseline !== null && diff.baseline !== undefined
      var changed = hasBase && stats && stats.files > 0
      // 没有差异时这条不该占位置，但「仍要还原」被点过一次：那句问话得留在原地，
      // 否则它悄悄消失，用户按下去的还原就再没人接。
      if (!changed && outside === null) return jumpCard

      // 有差异才是「相对上个检查点」；此刻点还原就是把磁盘拉回这一版，标题写的就是它。
      var head = [h('span', { key: 'title', className: 'fh-title' }, changed ? t('diffTitle') : t('dockRevert'))]
        .concat(statsSpans(t, stats))
        .concat([h('span', { key: 'chevron', className: 'fh-chevron' }, open ? '▴' : '▾')])
      var rows = []
      if (open) {
        var list = diff.changes || []
        for (var i = 0; i < list.length; i += 1) rows.push(changeRow(t, list[i], true))
        if (list.length === 0) rows.push(h('div', { key: '#none', className: 'fh-row fh-note fh-row-flat' }, t('empty')))
      }

      var footer = baseFooter({ t: t, changed: changed, pending: ask !== null, ask: ask, busy: busy, setAsk: setAsk, run: run, outside: outside, setOutside: setOutside })

      var bar = h('div', { key: 'bar', className: 'fh-card fh-base' },
        h('div', { className: 'fh-head', onClick: function () { setOpen(!open) } }, head),
        open ? h('div', { className: 'fh-body' }, rows) : null,
        h('div', { className: 'fh-foot' }, footer),
        noticeLine(notice)
      )
      return jumpCard === null ? bar : h('div', { className: 'fh-stack' }, jumpCard, bar)
    }

    // ---- 时间线的一行 ----------------------------------------------------------
    // 一行 = 时间 · 标题 · 摘要 · 增删：平时只有一行，点开才展开完整的卡片。
    // 必须是组件而不是普通函数：行内要用 useState 记住展开状态。
    function TLine(props) {
      var t = props.t
      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var stats = props.stats
      var sum = props.sum !== undefined ? props.sum : (stats && typeof stats.files === 'number' ? stats.files + ' ' + t('files') : '')
      var stat = null
      if (stats && typeof stats.files === 'number' && stats.files > 0) {
        stat = h('span', { className: 'fh-node-stat' },
          h('span', { className: 'fh-add' }, '+' + stats.additions),
          h('span', { className: 'fh-del' }, '-' + stats.deletions))
      }
      // 级别只看两件事：这一格是不是当前，以及它是不是特殊节点（检查点、手改出的当前）。
      var role = props.current === true ? 'current' : (props.special === true ? 'checkpoint' : 'turn')
      var rowClass = 'fh-tl-row fh-tl-row-' + role + (props.foreign === true ? ' fh-tl-row-foreign' : '')
      return h('div', { className: rowClass },
        h('span', { className: 'fh-tl-dot ' + (props.current === true ? 'fh-tl-dot-now' : (props.dotClass || '')) }, props.foreign === true ? h('i', { key: 'ring' }) : null),
        h('div', { className: 'fh-node', onClick: function () { setOpen(!open) } },
          h('span', { className: 'fh-node-time' }, timeText(props.time)),
          h('span', { className: 'fh-node-title' }, props.title),
          // 「当前」是一枚指针标记：它贴在哪个节点上，当前就停在哪一格。
          props.current === true ? h('span', { className: 'fh-node-now' }, t('now')) : null,
          h('span', { className: 'fh-node-sum' }, sum),
          stat,
          h('span', { className: 'fh-chevron' }, open ? '▴' : '▾')),
        open ? h(Entry, props.entryProps) : null)
    }

    // ---- 回复下方的动作行 ------------------------------------------------------
    // 这一轮扫过了，但文件没有改动：账本里没有快照，所以只有一颗「设为检查点」——
    // 留下的就是最后一份有差异的快照。还原类按钮在这一轮没有意义，不出现。
    function QuietTurn(props) {
      var t = props.t
      var busyState = React.useState(false)
      var noticeState = React.useState(null)
      async function save() {
        busyState[1](true)
        noticeState[1](null)
        try {
          var value = await props.call('point', { sessionId: props.sessionId, action: 'set' })
          noticeState[1](checkpointNotice(t, value))
          props.onChanged()
        } catch (error) {
          noticeState[1]({ tone: 'error', text: errText(error) })
        }
        busyState[1](false)
      }
      return h('div', { className: 'fh-card fh-card-turn fh-card-actions' },
        h('div', { className: 'fh-foot' },
          h('button', { key: 'baseline', className: 'fh-btn fh-btn-end', disabled: busyState[0], onClick: save }, t('baselineNew'))),
        noticeLine(noticeState[0]))
    }

    // 账本里不存统计：轮次记录只带逐文件改动，加起来就是三个数。
    function statsOf(changes) {
      var list = Array.isArray(changes) ? changes : []
      var stats = { files: list.length, additions: 0, deletions: 0, binary: 0 }
      for (var i = 0; i < list.length; i += 1) {
        stats.additions += list[i].additions || 0
        stats.deletions += list[i].deletions || 0
        if (list[i].binary) stats.binary += 1
      }
      return stats
    }

    // 检查点里挂着的那份轮次记录：拼回快照的形状，两种点在界面上长得一模一样。
    function entryOfPoint(point, sessionId) {
      var copy = point.entry && typeof point.entry === 'object' ? point.entry : {}
      return {
        sessionId: sessionId,
        turn: point.turn,
        time: point.time,
        base: typeof copy.base === 'string' && copy.base !== '' ? copy.base : point.tree,
        tree: point.tree,
        startSeq: copy.startSeq || 0,
        endSeq: copy.endSeq || 0,
        stats: statsOf(copy.changes),
        changes: Array.isArray(copy.changes) ? copy.changes : [],
        skipped: copy.skipped || 0,
        capped: copy.capped || 0,
        repos: Array.isArray(copy.repos) ? copy.repos : [],
        commit: copy.commit || null
      }
    }

    function Card(props) {
      var t = props.t
      var call = props.call
      var uiWorkspace = props.uiWorkspace
      var sessionId = props.sessionId
      var raw = props.matched !== undefined ? props.matched : props.turn
      // 0.1.7 的轮次槽直接把轮次号交过来；旧接口给的是一行记录，两种都认。
      var turn = typeof raw === 'number' ? raw : raw !== null && typeof raw === 'object' ? raw.turn : undefined
      // 它要的那一行是共用数据里轮次清单的子集：这一轮还没记账就先不渲染，
      // 轮次结束那次取数会把这一行带回来，卡片随之出现。
      var data = useStore(call, sessionId)
      // 这张卡出现本身就说明这一轮结束了：先让宿主把快照写完，再按这一轮重读账本。
      // 不这么做的话，取数和「这一轮结束」互相依赖，谁都不会先动。
      React.useEffect(function () {
        if (turn === undefined) return
        fetchStore(call, sessionId, turn)
      }, [sessionId, turn])
      // 轮次写入账本的那一刻就是这一轮结束：拿它当信号，通知改动条与侧栏重取一次。
      var fired = React.useRef(null)
      React.useEffect(function () {
        if (data === null || !Array.isArray(data.entries) || turn === undefined) return
        if (Array.isArray(data.blank) && data.blank.indexOf(turn) >= 0) {
          if (fired.current === turn) return
          fired.current = turn
          fireTurnEnd(turn)
          return
        }
        for (var i = 0; i < data.entries.length; i += 1) {
          var row = data.entries[i]
          if (row.sessionId !== sessionId || row.turn !== turn) continue
          if (!row.stats || row.stats.files === 0) continue
          if (fired.current === turn) return
          fired.current = turn
          fireTurnEnd(turn)
          return
        }
      }, [data, sessionId, turn])

      if (data === null) return null
      // 关掉之后这条会话不再有记录：已经记下的轮次也不在对话里出卡片。
      if (data.off === true) return null
      if (data.notice === 'git-unavailable') {
        return h('div', { className: 'fh-card' }, h('div', { className: 'fh-head fh-warn' }, t('gitMissing')))
      }
      var list = data.entries || []
      var found = null
      var newest = null
      for (var i = 0; i < list.length; i += 1) {
        // 清单里还带着父分支的轮次，轮次号可能撞上：卡片只认自己这条线。
        if (list[i].sessionId !== sessionId) continue
        if (list[i].stats && list[i].stats.files === 0) continue
        if (newest === null || list[i].time > newest.time) newest = list[i]
        if (found === null && list[i].turn === turn) found = list[i]
      }
      var onChanged = function () { reloadSession(call, sessionId) }
      // 这一轮有没有被设成检查点：有就把「设为检查点」换成「删除」，其余动作一样不少。
      var point = null
      var points = data.baselines || []
      // 最末一条记录才给撤销：它后面没有别的轮次，退回去不会跨过谁。
      // 检查点也是记录，所以两边一起比；只比轮次会让"刚转成检查点的这一轮"丢掉撤销。
      var newestTime = newest === null ? 0 : newest.time
      for (var p = 0; p < points.length; p += 1) {
        if (points[p].sessionId !== sessionId) continue
        if (points[p].time > newestTime) newestTime = points[p].time
        if (points[p].turn === turn) point = points[p]
      }
      // 设过检查点的轮次在账本里只剩检查点这一条：用它挂着的那份记录拼回原样，卡片长得和快照一模一样。
      if (found === null && point !== null) found = entryOfPoint(point, sessionId)
      // 这一轮没有文件历史：没扫过（自动拍快照关着）就什么都不显示，一颗按钮也不留。
      if (found === null) {
        if (!Array.isArray(data.blank) || data.blank.indexOf(turn) < 0) return null
        return h(QuietTurn, { t: t, call: call, sessionId: sessionId, onChanged: onChanged })
      }
      return h(Entry, {
        t: t,
        call: call,
        sessionId: sessionId,
        entry: found,
        // 这一轮的检查点：卡片照旧给全套动作，只把「设为检查点」换成「删除」。
        checkpoint: point !== null,
        tree: point !== null ? point.tree : undefined,
        // 只有最末一条记录能撤销；这一轮有没有改动，由卡片自己判断。
        manual: point !== null,
        undo: found.time === newestTime,
        // 关掉文件历史的会话里，以前记下的轮次卡还在，但「设为检查点」要按这条会话的开关收起来。
        off: data.off === true,
        uiWorkspace: uiWorkspace,
        headTitle: t('title'),
        timeLabel: timeText(found.time),
        bare: true,
        onChanged: function () { reloadSession(call, sessionId) }
      })
    }

    // ---- 右侧栏：上 2/3 时间线，下 1/3 这条会话的设置 --------------------------
    function Panel(props) {
      var t = props.t
      var call = props.call
      var uiWorkspace = props.uiWorkspace
      var sessionId = props.sessionId
      var data = useStore(call, sessionId)

      // 开关点下去先按新状态显示，账本回来再交还给它；失败就回弹。
      var wishState = React.useState(null)
      var wish = wishState[0]
      var setWish = wishState[1]
      var onData = !(data !== null && data.off === true)
      React.useEffect(function () {
        if (wish !== null && wish === onData) setWish(null)
      }, [onData, wish])
      var autoState = React.useState(null)
      var autoWish = autoState[0]
      var setAutoWish = autoState[1]
      var autoData = !(data !== null && data.auto === false)
      React.useEffect(function () {
        if (autoWish !== null && autoWish === autoData) setAutoWish(null)
      }, [autoData, autoWish])
      // 清理是一次性的动作，三样状态放一处：正在问哪一档、是否在跑、上次为什么失败。
      var clearState = React.useState({ ask: null, busy: false, error: null })
      var clearUi = clearState[0]
      var setClear = clearState[1]
      // 底栏动作自己也有一次往返：跑着的时候不许再点，失败沿用面板那条错误行。
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      // 规则是框里编辑、点保存才写回；draft 为 null 表示跟着账本走，不另存一份。
      var draftState = React.useState(null)
      var draft = draftState[0]
      var setDraft = draftState[1]
      var allowState = React.useState(null)
      var allowDraft = allowState[0]
      var setAllowDraft = allowState[1]
      // 「留几轮」是数字框：编辑时不写，失焦或回车才提交。
      var keepState = React.useState(null)
      var keepDraft = keepState[0]
      var setKeepDraft = keepState[1]
      var pruneState = React.useState(null)
      var pruneDraft = pruneState[0]
      var setPruneDraft = pruneState[1]

      if (data === null) return h('div', { className: 'fh-panel' }, h('div', { className: 'fh-panel-empty' }, t('working')))
      if (data.notice === 'git-unavailable') return h('div', { className: 'fh-panel' }, h('div', { className: 'fh-panel-empty fh-warn' }, t('gitMissing')))
      // 快照没拍成要直说原因，否则界面上看起来就是「什么都没发生」。
      var failure = data.notice === null || data.notice === undefined ? null : String(data.notice)

      // 时间线按时间倒序：检查点与轮次合在一起排。
      var entries = data.entries || []
      var rest = []
      var kept = data.baselines || []
      for (var b = 0; b < kept.length; b += 1) rest.push(Object.assign({ kind: 'baseline', at: b }, kept[b]))
      for (var i = 0; i < entries.length; i += 1) {
        // 早期版本把没有改动的轮次也记了账，这里一并滤掉：时间线只留真的动过文件的轮次。
        if (entries[i].stats && entries[i].stats.files === 0) continue
        // 这一轮已经被设成检查点：时间线上由检查点那一行代表，不再重复出一条轮次行。
        var covered = false
        for (var c2 = 0; c2 < kept.length; c2 += 1) {
          if (kept[c2].turn === entries[i].turn && kept[c2].sessionId === entries[i].sessionId) {
            covered = true
            break
          }
        }
        if (covered) continue
        rest.push({ kind: 'turn', time: entries[i].time, entry: entries[i] })
      }
      rest.sort(function (a, b) { return b.time - a.time })
      // 最末一条记录（轮次或检查点）：撤销只挂在它身上。
      var newestAny = rest.length === 0 ? null : rest[0]

      // 读取路径不扫盘，所以这里不判断工作树停在哪一格：顶部这一行固定代表磁盘现状。
      var rows = [h(TLine, {
        key: '#now',
        t: t,
        special: true,
        current: true,
        dotClass: 'fh-tl-dot-now',
        title: t('now'),
        time: null,
        stats: null,
        sum: t('nowHint'),
        entryProps: {
          t: t,
          call: call,
          sessionId: sessionId,
          openByDefault: true,
          pointer: true,
          entry: { changes: [], stats: { files: 0, additions: 0, deletions: 0 } },
          headTitle: t('now'),
          onChanged: function () { reloadSession(call, sessionId) }
        }
      })]
      for (var k = 0; k < rest.length; k += 1) {
        var item = rest[k]
        if (item.kind === 'baseline') {
          rows.push(h(TLine, {
            key: '#baseline' + item.at,
            t: t,
            special: true,
            dotClass: item.source === 'origin' ? 'fh-tl-dot-origin' : item.source === 'fork' ? 'fh-tl-dot-fork' : 'fh-tl-dot-manual',
            title: t('baseline'),
            time: item.time,
            stats: { files: 0, additions: 0, deletions: 0 },
            // 检查点也标出落在第几轮：它和轮次行在同一条时间线上，位置要说得清。
            sum: (item.source === 'origin' ? t('baselineOriginHint') : item.source === 'fork' ? t('baselineForkHint') : item.at === 0 ? t('baselineSavedHint') : t('baselineOlderHint'))
              + (typeof item.turn === 'number' ? ' · ' + t('turnLabel') + ' ' + item.turn + ' ' + t('turnUnit') : ''),
            entryProps: {
              t: t,
              sessionId: sessionId,
              openByDefault: true,
              call: call,
              // 检查点和快照长得一模一样：清单、统计、逐文件改动都从检查点里带过来，
              // 只把最后一颗按钮换成「删除检查点」。
              checkpoint: true,
              // 手动设的点：能删，也能从它分支。
              manual: item.source === 'manual',
              rowSessionId: item.sessionId,
              tree: item.tree,
              // 只有最末一条记录能撤销；这一轮有没有改动，由卡片自己判断。
              undo: item === newestAny,
              entry: entryOfPoint(item, item.sessionId),
              headTitle: t('baseline'),
              onChanged: function () { reloadSession(call, sessionId) }
            }
          }))
          continue
        }
        var entry = item.entry
        rows.push(h(TLine, {
          key: entry.sessionId + '#' + entry.turn,
          t: t,
          title: t('turnLabel') + ' ' + entry.turn + ' ' + t('turnUnit'),
          time: entry.time,
          stats: entry.stats,
          // 父分支的轮次：对话不能还原，整行标灰，免得看成自己这条线的一轮。
          foreign: entry.sessionId !== sessionId,
          entryProps: {
            t: t,
            call: call,
            sessionId: sessionId,
            // 祖先行属于父分支：还原文件要拿它自己那一轮去查，不能借用当前会话。
            rowSessionId: entry.sessionId,
            openByDefault: true,
            entry: entry,
            undo: item === newestAny,
            uiWorkspace: uiWorkspace,
            // 关掉的会话不能再添新检查点，按钮就不出现。
            off: data.off === true,
            headTitle: t('turnLabel') + ' ' + entry.turn + ' ' + t('turnUnit'),
            onChanged: function () { reloadSession(call, sessionId) }
          }
        }))
      }
      // 关掉之后时间线照旧列着，只是不再长——顶部加一行说明它不是坏了，是停在这里了。
      if (data.off === true) {
        rows.unshift(h('div', { key: '#off', className: 'fh-tl-row fh-tl-row-note' },
          h('span', { className: 'fh-tl-dot' }),
          h('div', { className: 'fh-node' }, h('span', { className: 'fh-node-title' }, t('offNote')))))
      }
      if (rest.length === 0) {
        rows.push(h('div', { key: '#empty', className: 'fh-tl-row' },
          h('span', { className: 'fh-tl-dot' }),
          h('div', { className: 'fh-panel-empty' }, t('empty'))))
      }

      // 清完要把整条时间线重读一遍：账本变了，留着旧数组只会显示已经不存在的轮次。
      async function clearHistory() {
        var scope = clearUi.ask
        setClear({ ask: scope, busy: true, error: null })
        try {
          await call('clear', { sessionId: sessionId, scope: scope })
          setClear({ ask: null, busy: false, error: null })
          reloadSession(call, sessionId)
        } catch (error) {
          setClear({ ask: scope, busy: false, error: errText(error) })
          // 回收失败时记录也已经清了，界面得跟着走。
          reloadSession(call, sessionId)
        }
      }

      // 这棵树的设置全走一个端点。点下去先按新值显示，账本回来再交还给它；
      // 没存上就回弹，别让界面停在一个账本里没有的状态。
      async function patchConfig(patch) {
        setBusy(true)
        try {
          await call('config', Object.assign({ sessionId: sessionId }, patch))
          setClear({ ask: null, busy: false, error: null })
          reloadSession(call, sessionId)
        } catch (error) {
          setWish(null)
          setAutoWish(null)
          setClear({ ask: null, busy: false, error: errText(error) })
        } finally {
          setBusy(false)
        }
      }

      // 开关上写的是「启用」，账本里记的是「关掉」，两个说法差一个非，别在这里接反。
      function toggleCheck(enabled) {
        setWish(enabled)
        patchConfig({ off: !enabled })
      }

      function toggleAuto(next) {
        setAutoWish(next)
        patchConfig({ auto: next })
      }

      // 数字框失焦或回车才算数；没改、或改成同一个值就什么都不写。
      function commitKeep() {
        if (keepDraft === null) return
        var next = Math.round(Number(keepDraft))
        setKeepDraft(null)
        if (!isFinite(next)) return
        if (next === data.keep) return
        patchConfig({ keep: Math.max(0, Math.min(1000, next)) })
      }

      function commitPrune() {
        if (pruneDraft === null) return
        var next = Math.round(Number(pruneDraft))
        setPruneDraft(null)
        if (!isFinite(next)) return
        if (next === data.prune) return
        patchConfig({ prune: Math.max(0, Math.min(100, next)) })
      }

      // 两个规则框共用一条保存路径：写回 config，成功后把草稿交还给账本。
      async function saveList(field, text, reset) {
        setBusy(true)
        try {
          var patch = { sessionId: sessionId }
          patch[field] = text
          await call('config', patch)
          reset()
          setClear({ ask: null, busy: false, error: null })
          reloadSession(call, sessionId)
        } catch (error) {
          setClear({ ask: null, busy: false, error: errText(error) })
        } finally {
          setBusy(false)
        }
      }

      var onNow = wish === null ? onData : wish
      var autoNow = autoWish === null ? autoData : autoWish
      var savedRules = (data.excludes || []).join('\n')
      var ruleText = draft === null ? savedRules : draft
      var allowSaved = (data.allow || []).join('\n')
      var allowText = allowDraft === null ? allowSaved : allowDraft
      // 有没保存的改动才出一个 footer：放弃在左，保存是实心那颗。
      function editFooter(dirty, save, reset) {
        if (!dirty) return null
        return h('div', { className: 'fh-set-foot' },
          h('button', { key: 'back', className: 'fh-cbtn', disabled: busy, onClick: reset }, t('cancel')),
          h('button', { key: 'save', className: 'fh-cbtn fh-cbtn-save', disabled: busy, onClick: save }, busy ? t('working') : t('saveGo')))
      }
      // 规则输入框：一行一条，只写路径。
      function rulesArea(value, onChange, placeholder) {
        return h('textarea', {
          className: 'fh-set-area',
          rows: 3,
          spellCheck: false,
          placeholder: placeholder,
          value: value,
          disabled: busy,
          onChange: function (event) { onChange(event.target.value) }
        })
      }
      // 开关行：标签在左、Switch 在右，下面一行说明。两条开关只有文案和回调不同。
      function switchField(key, labelKey, hintKey, checked, toggle) {
        return setField(key, [
          setRow(t(labelKey), h(Switch, { checked: checked, disabled: busy, label: t(labelKey), onChange: toggle })),
          setHint(t(hintKey))
        ])
      }
      // 规则行：一个多行框加说明；只有改过才出「取消／保存」。
      function ruleField(key, labelKey, hintKey, noneKey, text, saved, setText) {
        return setField(key, [
          setRow(t(labelKey), null),
          rulesArea(text, setText, t(noneKey)),
          setHint(t(hintKey)),
          editFooter(text !== saved, function () {
            saveList(key, text, function () { setText(null) })
          }, function () { setText(null) })
        ])
      }
      // 清空是两档：只抹流水账，或连检查点一起抹。问过再动手，按钮就在同一行右侧。
      function clearField(key, label, scope, confirmText, danger) {
        var asking = clearUi.ask === scope
        return setField(key, [
          setRow(label, asking
            ? h('span', { className: 'fh-set-input' },
                h('button', { key: 'yes', className: 'fh-cbtn fh-cbtn-danger', disabled: clearUi.busy, onClick: clearHistory }, clearUi.busy ? t('working') : t('clearGo')),
                h('button', { key: 'no', className: 'fh-cbtn', disabled: clearUi.busy, onClick: function () { setClear({ ask: null, busy: false, error: null }) } }, t('cancel')))
            : h('button', { className: danger ? 'fh-cbtn fh-cbtn-danger' : 'fh-cbtn', onClick: function () { setClear({ ask: scope, busy: false, error: null }) } }, t('clearGo'))),
          asking ? setHint(confirmText) : null
        ])
      }

      // 两道裁剪是「同时满足」：轮次要落在最近 M 轮里，也不能早于倒数第 N 个检查点。
      var pruneRow = setField('prune', [
        setRow(t('setPrune'), h('span', { className: 'fh-set-input' },
          h('input', {
            className: 'fh-set-num',
            type: 'number',
            min: 0,
            max: 100,
            step: 1,
            disabled: busy,
            value: pruneDraft === null ? String(data.prune === null || data.prune === undefined ? 2 : data.prune) : pruneDraft,
            onChange: function (event) { setPruneDraft(event.target.value) },
            onBlur: commitPrune,
            onKeyDown: function (event) { if (event.key === 'Enter') commitPrune() }
          }),
          h('span', { className: 'fh-set-unit' }, t('setUnitPiece')))),
        setHint(t('hintPrune'))
      ])
      var keepRow = setField('keep', [
        setRow(t('setKeep'), h('span', { className: 'fh-set-input' },
          h('input', {
            className: 'fh-set-num',
            type: 'number',
            min: 0,
            max: 1000,
            step: 1,
            disabled: busy,
            value: keepDraft === null ? String(data.keep === null || data.keep === undefined ? 20 : data.keep) : keepDraft,
            onChange: function (event) { setKeepDraft(event.target.value) },
            onBlur: commitKeep,
            onKeyDown: function (event) { if (event.key === 'Enter') commitKeep() }
          }),
          h('span', { className: 'fh-set-unit' }, t('setUnitTurn')))),
        setHint(t('hintKeep'))
      ])
      // 占用是只读的一行信息：一个快照都没有时不显示，免得空摆一个 0 KB。
      var usageBytes = data.usage === null || data.usage === undefined ? 0 : data.usage.total
      var usageRow = usageBytes <= 0 ? null : setField('usage', [
        setRow(t('usageLabel'), h('span', { className: 'fh-set-value' }, sizeText(usageBytes))),
        setHint(t('usageHint'))
      ])

      var configRows = [
        switchField('off', 'offLabel', 'offHint', onNow, toggleCheck),
        switchField('auto', 'autoLabel', 'autoHint', autoNow, toggleAuto),
        pruneRow,
        keepRow,
        ruleField('rules', 'excludeLabel', 'excludeHint', 'excludeNone', ruleText, savedRules, setDraft),
        ruleField('allow', 'allowLabel', 'allowHint', 'allowNone', allowText, allowSaved, setAllowDraft),
        clearField('turns', t('clearTurns'), 'turns', t('clearTurnsConfirm'), false),
        clearField('all', t('clearAll'), 'all', t('clearAllConfirm'), true),
        usageRow
      ]

      return h('div', { className: 'fh-pane' },
        h('div', { className: 'fh-tl-wrap' }, h('div', { className: 'fh-tl' }, rows)),
        h('div', { className: 'fh-config' },
          configRows,
          clearUi.error === null ? null : h('div', { className: 'fh-error' }, clearUi.error),
          failure === null ? null : h('div', { className: 'fh-error' }, failure)))
    }

    // ---- 设置页里属于本插件的一页 ----------------------------------------------
    // 按常用程度从上往下排：三个界面开关在前，数量类在后。factor 把界面单位换成存储单位——字节按 MB 给人看。
    var FIELDS = [
      { key: 'turnCard', type: 'bool', label: 'setTurnCard', hint: 'hintTurnCard' },
      { key: 'dock', type: 'bool', label: 'setDock', hint: 'hintDock' },
      { key: 'timeline', type: 'bool', label: 'setTimeline', hint: 'hintTimeline' },
      { key: 'keepRecentTurns', type: 'num', label: 'setKeep', hint: 'hintKeepDefault', unit: 'setUnitTurn', min: 0, max: 1000, step: 1 },
      { key: 'maxFileBytes', type: 'num', label: 'setFileSize', hint: 'hintFileSize', unit: 'setUnitMB', min: 0, max: 1024, step: 1, factor: 1048576 },
      { key: 'maxRepoFiles', type: 'num', label: 'setRepoFiles', hint: 'hintRepoFiles', unit: 'setUnitPiece', min: 0, max: 1000000, step: 1000 },
      { key: 'maxBytes', type: 'num', label: 'setTotal', hint: 'hintTotal', unit: 'setUnitMB', min: 0, max: 1048576, step: 256, factor: 1048576 },
      { key: 'pruneAfterCheckpoints', type: 'num', label: 'setPrune', hint: 'hintPruneDefault', unit: 'setUnitPiece', min: 0, max: 100, step: 1 }
    ]

    // 快照是客户端这边的镜像：订阅一次，宿主一提交再取一份。
    function useSettingsSnapshot(scope) {
      var pair = React.useState(function () { return scope.getSnapshot() })
      React.useEffect(function () {
        pair[1](scope.getSnapshot())
        return scope.subscribe(function () { pair[1](scope.getSnapshot()) })
      }, [scope])
      return pair[0]
    }

    // 读不到就当开着：插件默认是三个界面都在。
    function flagOf(snapshot, key) {
      if (!snapshot || snapshot.status !== 'ready' || !snapshot.value) return true
      return snapshot.value[key] !== false
    }

    // 关掉时不光不渲染，连注册一起撤掉：留个空槽比不注册更难看。开关一变就重挂一次。
    function whenShown(scope, key, setup) {
      var dispose = null
      function sync() {
        var on = flagOf(scope.getSnapshot(), key)
        if (on && dispose === null) {
          dispose = setup() || function () {}
        } else if (!on && dispose !== null) {
          var stop = dispose
          dispose = null
          stop()
        }
      }
      sync()
      var off = scope.subscribe(sync)
      return function () {
        off()
        if (dispose !== null) dispose()
      }
    }

    function BoolRow(props) {
      var t = props.t
      var field = props.field
      var busy = React.useState(false)
      function flip(next) {
        busy[1](true)
        // 存没存上都把开关放开：宿主那边还没提交完时也不该一直锁着。
        Promise.resolve(props.scope.set(field.key, next))
          .catch(function () {})
          .then(function () { busy[1](false) })
      }
      return setField(field.key, [
        setRow(t(field.label), h(Switch, { checked: props.value, disabled: busy[0], label: t(field.label), onChange: flip })),
        setHint(t(field.hint))
      ])
    }

    function NumRow(props) {
      var t = props.t
      var field = props.field
      var factor = field.factor || 1
      var shown = typeof props.value === 'number' ? Math.round(props.value / factor) : ''
      // 输入框只在编辑时用草稿：不编辑的时候永远显示宿主那一份，别人改了也会跟着动。
      var draft = React.useState(null)
      var failed = React.useState(false)
      function commit() {
        var text = draft[0]
        if (text === null) return
        draft[1](null)
        var parsed = Number(String(text).trim())
        if (String(text).trim() === '' || !isFinite(parsed)) return
        var real = Math.round(parsed) * factor
        if (real < field.min * factor) real = field.min * factor
        if (real > field.max * factor) real = field.max * factor
        if (real === props.value) return
        failed[1](false)
        Promise.resolve(props.scope.set(field.key, real)).catch(function () { failed[1](true) })
      }
      return setField(field.key, [
        setRow(t(field.label), [
          h('span', { key: 'input', className: 'fh-set-input' },
            h('input', {
              type: 'number',
              className: 'fh-set-num',
              min: field.min,
              max: field.max,
              step: field.step,
              value: draft[0] === null ? String(shown) : draft[0],
              onChange: function (event) { draft[1](event.target.value) },
              onBlur: commit,
              onKeyDown: function (event) { if (event.key === 'Enter') event.currentTarget.blur() }
            }),
            h('span', { key: 'unit', className: 'fh-set-unit' }, t(field.unit))),
          failed[0] ? h('span', { key: 'failed', className: 'fh-error' }, t('saveFailed')) : null
        ]),
        setHint(t(field.hint))
      ])
    }

    function SettingsCard(props) {
      var t = props.t
      var scope = props.scope
      var snapshot = useSettingsSnapshot(scope)
      // 宿主还没把这一份发下来时整块不出现，免得先亮一排默认值再跳一次。
      if (snapshot.status !== 'ready' || !snapshot.value) return null
      var value = snapshot.value
      // 这份内容就是设置页里那个 tab 的正文，名字已经在 tab 标签上。
      return h('div', { className: 'fh-set-tab' },
        h('div', { className: 'fh-set-rows' }, FIELDS.map(function (field) {
          return field.type === 'bool'
            ? h(BoolRow, { key: field.key, t: t, scope: scope, field: field, value: value[field.key] !== false })
            : h(NumRow, { key: field.key, t: t, scope: scope, field: field, value: value[field.key] })
        })))
    }

    // ---- 注册 ------------------------------------------------------------------
    function apply(ctx) {
      var slots = ctx.slots
      var locale = ctx.locale
      var connection = ctx.connection
      var uiWorkspace = ctx.get('uiWorkspace')

      // 样式表由插件自己插进 <head>：客户端插件没有这类服务，官方插件也是这么写的。
      ctx.effect(function () {
        var tag = document.createElement('style')
        tag.setAttribute('data-plugin', 'dsh-file-history')
        tag.textContent = CSS
        document.head.appendChild(tag)
        return function () { tag.remove() }
      }, 'dsh-file-history: styles')

      ctx.effect(function () {
        return locale.register(NS, { zh: ZH, en: EN })
      }, 'dsh-file-history: dictionaries')

      var t = locale.bind(NS)
      // 设置页的那一页和三个界面开关共用这一份：宿主按插件条目 id 提供表单，客户端这边只是镜像。
      var settings = ctx.configForms.get(ENTRY_ID)

      async function call(endpoint, payload) {
        var result = await connection.rpc.call(CHANNEL, endpoint, payload)
        if (!result || result.ok !== true) {
          throw new Error(result && result.error ? result.error.message : 'request failed')
        }
        return result.value
      }

      // 设置页里的一页：0.1.7 的插件设置页按 tab 排列，内容是本插件的默认值。
      ctx.effect(function () {
        return slots.inject('settings.plugins.tab', function () {
          return slots.register(
            {
              name: 'settings.plugins.tab',
              id: ENTRY_ID,
              order: 60,
              label: function () { return t('panelTitle') },
              locale: NS
            },
            function () { return h(SettingsCard, { t: t, scope: settings }) }
          )
        })
      }, 'dsh-file-history: settings card')

      // 侧栏：时间线关掉时，标签类型和面板一起撤——只撤面板会留下一个空标签。
      ctx.effect(function () {
        return whenShown(settings, 'timeline', function () {
          var unTab = ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_ID,
            priority: 'extension',
            title: function () { return t('panelTitle') },
            guide: [{
              id: TAB_ID,
              order: 15,
              title: function () { return t('panelTitle') },
              description: function () { return t('panelDesc') },
              icon: IconClock
            }]
          })
          var unBody = slots.inject('sidebar.right.pane.tab', function () {
            return slots.register(
              { name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS },
              function (props) {
                return h(Panel, { t: t, call: call, uiWorkspace: uiWorkspace, sessionId: props.sessionId })
              }
            )
          })
          return function () {
            unBody()
            unTab()
          }
        })
      }, 'dsh-file-history: tab')

      // 回复下方：这个槽同时是「这一轮结束了」的信号来源，dock 与侧栏靠它刷新。
      // 所以不管卡片开关怎么设都要挂着，关掉时只不渲染卡片，别把信号一起撤掉。
      ctx.effect(function () {
        return slots.inject('conversation.chat.turnTail', function () {
          return slots.register(
            // order 0 是官方「已编辑 N 个文件」那张卡：动作行排在它后面，落在文件清单下方。
            { name: 'conversation.chat.turnTail', id: 'dsh-file-history-actions', locale: NS, order: 20 },
            function (props) {
              if (!flagOf(useSettingsSnapshot(settings), 'turnCard')) return null
              return h(Card, {
                t: t,
                call: call,
                uiWorkspace: uiWorkspace,
                sessionId: props.sessionId,
                turn: props.turn,
                onChanged: function () { reloadSession(call, props.sessionId) }
              })
            }
          )
        })
      }, 'dsh-file-history: turn tail')

      // 输入框上方：只在有检查点且有差异时才有内容。开关关掉就整条不注册。
      ctx.effect(function () {
        return whenShown(settings, 'dock', function () {
          return slots.inject('conversation.input.dock', function () {
            return slots.register(
              { name: 'conversation.input.dock', id: 'file-history-baseline', order: 10, label: function () { return t('baseline') } },
              function (props) {
                return h(Baseline, { t: t, call: call, uiWorkspace: uiWorkspace, sessionId: props.sessionId })
              }
            )
          })
        })
      }, 'dsh-file-history: baseline bar')
    }

    exports.name = 'dsh-file-history'
    exports.inject = ['connection', 'locale', 'slots', 'sidebarRightTabs', 'configForms']
    exports.apply = apply
    return module.exports
  }
})
