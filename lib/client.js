window.__ModuleLoader__.load({
  id: 'dsh-file-history',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    // 图标和设置页的开关都来自官方控件集；模块表里没有时留空，各自回落到自带的画法。
    var primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (error) {
      primitives = null
    }
    var IconClock = primitives && primitives.IconClockOutline16 || null
    var IconChevron = primitives && primitives.IconChevronDownOutline14 || null
    var Switch = primitives && primitives.Switch || null
    var h = React.createElement
    var CHANNEL = '/dsh-file-history'
    var NS = 'file-history'
    var TAB_ID = 'dsh-file-history'
    var MAX_ROWS = 50
    // 轮次结束是客户端本来就有的信号：turnTail 的 owner 带着 TurnLocation，
    // status 变成 closed 就说明宿主刚写完这一轮的快照。用它广播，视图不必轮询。
    var turnListeners = []
    function onTurnEnd(listener) {
      turnListeners.push(listener)
      return function () {
        var at = turnListeners.indexOf(listener)
        if (at >= 0) turnListeners.splice(at, 1)
      }
    }
    function fireTurnEnd(turn) {
      var list = turnListeners.slice()
      for (var i = 0; i < list.length; i += 1) {
        try {
          list[i](turn)
        } catch (error) {
          console.error('[file-history] ' + String(error && error.message ? error.message : error))
        }
      }
    }
    // 取数只有这一个入口：什么时候拉、要不要先等宿主落账、谁先谁后，都由这里决定。
    // 底部改动条和侧栏时间线订阅的是同一份结果，各自只管渲染，不再各拉各的。
    // 结果按会话分开存：侧栏、输入框、轮次卡可能同时看着两个会话（刚切过会话时就是这样），
    // 共用一个格子的话，后拉到的那一份会把别人的顶掉，另一边的界面立刻空白。
    var stores = new Map()
    var storeBusy = []
    var storePending = new Map()
    var storeReaders = []

    function publishStore(sessionId) {
      var list = storeReaders.slice()
      for (var i = 0; i < list.length; i += 1) {
        try {
          list[i](sessionId)
        } catch (error) {
          console.error('[file-history] ' + String(error && error.message ? error.message : error))
        }
      }
    }

    // 改动条算的是「现在跟检查点差什么」，磁盘或检查点一动就得重算。由动手的那一方喊一声，
    // 比让改动条自己猜哪些返回值意味着磁盘变了可靠：还原、撤销还原、清除历史都从这里过。
    var diskListeners = []
    function onDiskChange(listener) {
      diskListeners.push(listener)
      return function () {
        var at = diskListeners.indexOf(listener)
        if (at >= 0) diskListeners.splice(at, 1)
      }
    }
    function fireDiskChange(sessionId) {
      var list = diskListeners.slice()
      for (var i = 0; i < list.length; i += 1) {
        try {
          list[i](sessionId)
        } catch (error) {
          console.error('[file-history] ' + String(error && error.message ? error.message : error))
        }
      }
    }

    function fetchStore(call, sessionId, turn) {
      if (sessionId === undefined || sessionId === null || sessionId === '') return null
      var known = stores.has(sessionId) ? stores.get(sessionId) : null
      // 同一轮重复喊刷新是常态（每个视图都会收到一次轮次结束），已经反映过这一轮就不再拉。
      if (typeof turn === 'number' && known !== null && known.turn === turn) return null
      if (storeBusy.indexOf(sessionId) >= 0) {
        // 拉的过程中又被叫了：只记最后一轮，拉完补一次，不叠请求。
        storePending.set(sessionId, turn)
        return null
      }
      storeBusy.push(sessionId)
      // 宿主写完快照才会回话，所以拿到回话后再读账本，读到的不可能还是旧账。
      var ready = typeof turn === 'number'
        ? call('wait', { sessionId: sessionId, turn: turn }).then(function () { return true }, function () { return false })
        : Promise.resolve(true)
      return ready.then(function () {
        return call('entries', { sessionId: sessionId }).then(function (value) {
          return value || {}
        }, function (error) {
          // 读失败单独标出来，列表本身沿用上一次的结果：一次抖动不该把整条历史抹掉。
          return { entries: null, notice: String(error && error.message ? error.message : error) }
        })
      }).then(function (rows) {
        if (rows.entries === null || rows.entries === undefined) {
          if (known === null) return
          stores.set(sessionId, Object.assign({}, known, { notice: rows.notice }))
          publishStore(sessionId)
          return
        }
        stores.set(sessionId, {
          sessionId: sessionId,
          turn: typeof turn === 'number' ? turn : null,
          entries: rows.entries,
          undo: rows.undo === true,
          notice: rows.notice === null || rows.notice === undefined ? null : rows.notice,
          baseline: rows.baseline || null,
          // 检查点按时间倒序，新的在前；旧宿主只给 baseline，这里补齐成一个也就够了。
          baselines: Array.isArray(rows.baselines) ? rows.baselines : rows.baseline ? [rows.baseline] : [],
          // 文件被同族另一条分支推到了最新时，那一支的会话 id；没有就是 null。
          elsewhere: rows.elsewhere || null
        })
        publishStore(sessionId)
      }, function () {}).then(function () {
        var at = storeBusy.indexOf(sessionId)
        if (at >= 0) storeBusy.splice(at, 1)
        var queued = storePending.has(sessionId)
        var next = storePending.get(sessionId)
        storePending.delete(sessionId)
        if (queued) fetchStore(call, sessionId, next)
      })
    }

    // 动了磁盘、动了检查点的那一方喊这里：重读这个会话的账本，再让改动条重算一次差异。
    function reloadSession(call, sessionId) {
      fetchStore(call, sessionId)
      fireDiskChange(sessionId)
    }
    // 视图这边只有两件事：订阅结果、在挂载时和轮次结束时由上面统一触发一次取数。
    function useStore(call, sessionId) {
      // 这里只用它触发重渲染，结果一律从 stores 里现取，渲染时不会看到别人会话的数据。
      var pair = React.useState(0)
      var setTick = pair[1]
      React.useEffect(function () {
        var alive = true
        function reader(id) {
          if (alive && id === sessionId) setTick(function (n) { return n + 1 })
        }
        storeReaders.push(reader)
        if (!stores.has(sessionId)) fetchStore(call, sessionId)
        var off = onTurnEnd(function (ended) {
          fetchStore(call, sessionId, ended !== null && ended !== undefined ? ended.turn : undefined)
        })
        return function () {
          alive = false
          off()
          var at = storeReaders.indexOf(reader)
          if (at >= 0) storeReaders.splice(at, 1)
        }
      }, [sessionId])
      return stores.has(sessionId) ? stores.get(sessionId) : null
    }

    var CSS = [
      '.fh-row-flat{cursor:default}',
      '.fh-row-flat:hover{background:transparent}',
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
      '.fh-body{border-top:1px solid var(--dsw-alias-border-l1)}',
      '.fh-row{display:flex;align-items:center;gap:8px;padding:3px 10px;cursor:pointer;color:var(--dsw-alias-label-secondary)}',
      '.fh-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.fh-kind{flex:none;width:14px;text-align:center;color:var(--dsw-alias-label-tertiary)}',
      '.fh-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-primary)}',
      '.fh-patch{margin:0;padding:6px 10px 8px 26px;max-height:320px;overflow:auto;background:var(--dsw-alias-bg-base);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;white-space:pre;color:var(--dsw-alias-label-secondary)}',
      '.fh-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.fh-btn{appearance:none;min-width:0;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer;background:0 0;border:none;border-radius:8px;align-items:center;gap:4px;padding:0 8px;font:inherit;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}',
      '.fh-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.fh-btn:disabled{cursor:default;opacity:.45;color:var(--dsw-alias-label-tertiary)}',
      '.fh-btn-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.fh-btn-end{margin-left:auto}',
      '.fh-foot-end{justify-content:flex-end}',
      // 检查点是被特意留下来的一版：左侧一条强调色，和「第 N 轮」这类流水记录区分开。
      '.fh-card-chk{border-color:var(--dsw-alias-border-l2);box-shadow:inset 2px 0 0 var(--dsw-alias-state-warn-primary)}',
      // 「当前」是自己的一格：手改出来、还没被任何轮次或检查点记下来的那一版，同样按重的处理。
      '.fh-card-now{border-color:var(--dsw-alias-border-l2);box-shadow:inset 2px 0 0 var(--dsw-alias-state-business-primary)}',
      // 设置页那张卡照官方那张插件卡来：默认折叠，点标题展开，展开的是一行一个 field。
      '.fh-set{border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s}',
      '.fh-set:hover{border-color:var(--dsw-alias-label-dimmed)}',
      '.fh-set-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
      '.fh-set-head{appearance:none;width:100%;padding:14px 16px;display:flex;align-items:center;gap:12px;border:0;border-radius:12px;background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.fh-set-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.fh-set-headText{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0}',
      '.fh-set-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
      '.fh-set-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}',
      '.fh-chev{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}',
      '.fh-chev-open{transform:rotate(180deg)}',
      '.fh-set-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
      '.fh-set-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
      '.fh-set-field+.fh-set-field{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.fh-set-row{display:flex;align-items:center;gap:8px}',
      '.fh-set-label{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}',
      '.fh-set-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}',
      '.fh-set-input{display:flex;align-items:center;gap:6px}',
      '.fh-set-num{width:88px;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5;text-align:right}',
      '.fh-set-num:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
      '.fh-set-unit{flex:none;width:30px;color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.fh-sw{position:relative;flex:none;width:32px;height:18px;padding:0;border:none;border-radius:9px;background:var(--dsw-alias-border-l2);cursor:pointer;transition:background .15s}',
      '.fh-sw-on{background:var(--dsw-alias-state-business-primary)}',
      '.fh-sw:disabled{cursor:default;opacity:.45}',
      '.fh-sw-dot{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);transition:left .15s}',
      '.fh-sw-on .fh-sw-dot{left:16px}',
      '.fh-note{color:var(--dsw-alias-label-tertiary)}',
      '.fh-error{color:var(--dsw-alias-state-error-primary)}',
      '.fh-ok{color:var(--dsw-alias-state-success-primary)}',
      '.fh-panel{display:flex;flex-direction:column;gap:8px;padding:8px;overflow:auto;height:100%;box-sizing:border-box}',
      '.fh-panel-empty{padding:16px 8px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);text-align:center}',
      '.fh-tl{display:flex;flex-direction:column;gap:2px}',
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
      '.fh-node{display:flex;align-items:center;gap:10px;min-width:0;padding:var(--fh-pad);border-radius:8px;cursor:pointer}',
      '.fh-node:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.fh-node-time{flex:none;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;font-variant-numeric:tabular-nums}',
      '.fh-node-title{flex:none;color:var(--fh-fg);font-size:var(--fh-fs);font-weight:var(--fh-fw);line-height:20px}',
      '.fh-node-sum{min-width:0;flex:auto;color:var(--dsw-alias-label-tertiary);font-size:var(--fh-sum);line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.fh-node-stat{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;display:inline-flex;gap:6px}',
      // 父分支的轮次整行压暗一档，和本线自己的轮次分开。
      '.fh-tl-row-foreign .fh-node-title{color:var(--dsw-alias-label-tertiary)}',
      '.fh-tl-row-foreign .fh-node-time,.fh-tl-row-foreign .fh-node-sum,.fh-tl-row-foreign .fh-node-stat{opacity:.6}',
      '.fh-tl-row .fh-card{margin:2px 0 6px}',
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
      truncated: '（补丁过长，已截断）',
      diffTitle: '改动',
      revertFiles: '还原文件',
      revertChat: '还原对话',
      revertBoth: '全部还原',
      branch: '从这里开分支',
      undo: '撤销还原',
      confirmFiles: '把文件还原到这一轮开始前的状态？本轮改动会被覆盖。',
      confirmChat: '把对话还原到这一轮之前？会新建一个会话，原会话保留。',
      confirmBoth: '文件和对话都还原到这一轮之前？',
      confirm: '还原',
      cancel: '取消',
      working: '处理中…',
      filesDone: '文件已还原',
      chatDone: '对话已还原，已切换到新会话',
      branchDone: '分支开好了，已切换到新会话',
      undoDone: '已撤销还原',
      written: '写入',
      removed: '删除',
      // 界面上一律叫「检查点」，代码里的 baseline 是同一个东西的旧名。
      baseline: '检查点',
      baselineNew: '设为检查点',
      baselineRevert: '还原到检查点',
      baselineConfirm: '把文件还原到检查点？当前改动会被覆盖。',
      baselineDone: '已还原到检查点',
      now: '当前',
      nowHint: '当前工作区',
      baselineSavedHint: '保留的那一版',
      baselineOlderHint: '早一些的那一版',
      baselineOriginHint: '会话开始时的样子',
      baselineForkHint: '分支从这里出去',
      baselineBody: '这一版被留在这里，需要时可以把当前文件还原回去。',
      nowBody: '这是磁盘上的现状，还没有被任何一轮或检查点记下来。',
      baselineSaved: '已设为检查点',
      baselineNoChange: '没有改动，不用存',
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
      setDesc: '每轮对话结束后给整个工作区拍一张快照，这里管它的开关和上限。',
      hintTurnCard: '每轮对话结束，在那条回复下面列出改动的文件。',
      hintDock: '输入框上方那条提示，只在工作区和检查点有差别时出现。',
      hintTimeline: '右侧栏里把轮次和检查点排成一条线。',
      hintKeep: '超过这个数目的旧轮次会被清理，检查点不受影响。',
      hintFileSize: '超过这个大小的文件不记内容，只在卡片里标出来。',
      hintRepoFiles: '单个内嵌的仓库文件比这多，就整块跳过。',
      hintTotal: '快照总共占多少盘，超了先清最旧的轮次。',
      hintPrune: '每设一个检查点，就把走到它的轮次清掉。',
      setPrune: '检查点后清理到',
      setUnitTurn: '轮',
      setUnitPiece: '个',
      setUnitMB: 'MB',
      saveFailed: '没存上'
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
      truncated: '(patch truncated)',
      diffTitle: 'Changes',
      revertFiles: 'Revert files',
      revertChat: 'Revert chat',
      revertBoth: 'Revert both',
      branch: 'Branch from here',
      undo: 'Undo last revert',
      confirmFiles: 'Restore files to the state before this turn? This turn\'s changes will be overwritten.',
      confirmChat: 'Move the conversation back to before this turn? A new session is created; this one is kept.',
      confirmBoth: 'Revert both files and conversation to before this turn?',
      confirm: 'Confirm',
      cancel: 'Cancel',
      working: 'Working…',
      filesDone: 'Files restored',
      chatDone: 'Chat rewound, switched to the new session',
      branchDone: 'Branch created, switched to the new session',
      undoDone: 'Last revert undone',
      written: 'written',
      removed: 'removed',
      baseline: 'Checkpoint',
      baselineNew: 'Set as checkpoint',
      baselineRevert: 'Restore to checkpoint',
      baselineConfirm: 'Restore files to the checkpoint? Current changes will be overwritten.',
      baselineDone: 'Files restored to the checkpoint',
      now: 'Now',
      nowHint: 'Current workspace',
      baselineSavedHint: 'Snapshot of that moment',
      baselineOlderHint: 'The earlier one',
      baselineOriginHint: 'How it looked when the session began',
      baselineForkHint: 'The branch left from here',
      baselineBody: 'This version is kept here; you can restore the current files from it.',
      nowBody: 'This is what is on disk now; no turn or checkpoint has recorded it yet.',
      baselineSaved: 'Saved as checkpoint',
      baselineNoChange: 'No changes to save',
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
      setDesc: 'A snapshot of the whole workspace after each turn; its switches and limits live here.',
      hintTurnCard: 'Lists the changed files under each reply, once the turn ends.',
      hintDock: 'The bar above the input, shown only when the workspace differs from the checkpoint.',
      hintTimeline: 'Turns and checkpoints as one line in the sidebar.',
      hintKeep: 'Turns past this count get pruned; checkpoints stay.',
      hintFileSize: 'Files larger than this are listed but not stored.',
      hintRepoFiles: 'An embedded repository with more files than this is skipped whole.',
      hintTotal: 'Disk the snapshots may use; the oldest turns go first.',
      hintPrune: 'Each checkpoint prunes the turns leading up to it.',
      setPrune: 'Prune to checkpoint',
      setUnitTurn: 'turns',
      setUnitPiece: 'files',
      setUnitMB: 'MB',
      saveFailed: 'Not saved'
    }

    function Entry(props) {
      var t = props.t
      var call = props.call
      var entry = props.entry
      var sessionId = props.sessionId
      var uiWorkspace = props.uiWorkspace
      var onChanged = props.onChanged || function () {}
      var headTitle = props.headTitle || t('title')
      var undoable = props.undo === true
      // 「当前」行只是指针，点它没有可还原的东西；检查点行只做「还原到检查点」一件事，
      // 两者都不该出现轮次的还原文件/还原对话/设检查点按钮。
      var pointer = props.pointer === true
      var checkpointRow = props.checkpointRow === true
      // 时间线上会露出父分支的轮次：这一行属于哪条线，还原时就去哪条线找那一轮。
      var rowLine = typeof props.rowSessionId === 'string' && props.rowSessionId !== '' ? props.rowSessionId : sessionId
      var crossLine = rowLine !== sessionId
      var timeLabel = typeof props.timeLabel === 'string' ? props.timeLabel : ''
      // 侧栏时间线里卡片默认只占一行，按钮等展开后再出现，免得每行都挂三个按钮。
      var footOnOpen = props.footOnOpen === true
      var openByDefault = props.openByDefault === true
      var listState = React.useState(openByDefault)
      var showList = listState[0]
      var setShowList = listState[1]
      var openState = React.useState(null)
      var open = openState[0]
      var setOpen = openState[1]
      var patchState = React.useState(null)
      var patch = patchState[0]
      var setPatch = patchState[1]
      var pendingState = React.useState(null)
      var pending = pendingState[0]
      var setPending = pendingState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var noticeState = React.useState(null)
      var notice = noticeState[0]
      var setNotice = noticeState[1]
      var stats = entry.stats

      function toggleList() {
        if (showList) {
          setOpen(null)
          setPatch(null)
        }
        setShowList(!showList)
      }

      function toggleFile(relative) {
        if (open === relative) {
          setOpen(null)
          setPatch(null)
          return
        }
        setOpen(relative)
        setPatch(null)
        call('diff', { sessionId: rowLine, turn: entry.turn, path: relative }).then(
          function (value) { setPatch(value) },
          function (error) { setPatch({ patch: String(error.message || error), truncated: false }) }
        )
      }

      async function run(kind) {
        setBusy(true)
        setNotice(null)
        try {
          var value
          if (kind === 'checkpoint') value = await call('baseline', { sessionId: sessionId, action: 'revert', tree: props.tree })
          else if (kind === 'files') value = await call('revert-files', { sessionId: rowLine, turn: entry.turn })
          else if (kind === 'chat') value = await call('revert-chat', { sessionId: sessionId, turn: entry.turn })
          else if (kind === 'branch') value = await call('branch', { sessionId: rowLine, turn: entry.turn })
          else value = await call('revert-both', { sessionId: sessionId, turn: entry.turn })
          if (value.childSessionId !== undefined && uiWorkspace) uiWorkspace.openSession(value.childSessionId)
          var text = kind === 'chat' ? t('chatDone') : kind === 'checkpoint' ? t('baselineDone') : kind === 'branch' ? t('branchDone') : t('filesDone')
          if (kind !== 'chat') text += ' · ' + t('written') + ' ' + value.written + ' · ' + t('removed') + ' ' + value.removed
          setNotice({ tone: 'ok', text: text })
          setPending(null)
          onChanged()
        } catch (error) {
          setNotice({ tone: 'error', text: String(error.message || error) })
        } finally {
          setBusy(false)
        }
      }

      async function undo() {
        setBusy(true)
        setNotice(null)
        try {
          var value = await call('undo-revert', { sessionId: sessionId })
          setNotice({ tone: 'ok', text: t('undoDone') + ' · ' + t('written') + ' ' + value.written + ' · ' + t('removed') + ' ' + value.removed })
          onChanged()
        } catch (error) {
          setNotice({ tone: 'error', text: String(error.message || error) })
        } finally {
          setBusy(false)
        }
      }

      var rows = []
      var shown = entry.changes.slice(0, MAX_ROWS)
      for (var i = 0; i < shown.length; i += 1) {
        var change = shown[i]
        var marker = change.kind === 'added' ? 'A' : change.kind === 'deleted' ? 'D' : 'M'
        rows.push(
          h('div', {
            key: change.path,
            className: 'fh-row',
            onClick: (function (relative) { return function () { toggleFile(relative) } })(change.path)
          },
            h('span', { className: 'fh-kind' }, marker),
            h('span', { className: 'fh-path' }, change.path),
            change.binary
              ? h('span', { className: 'fh-stat' }, t('binary'))
              : h('span', { className: 'fh-stat' },
                  h('span', { className: 'fh-add' }, '+' + change.additions),
                  ' ',
                  h('span', { className: 'fh-del' }, '-' + change.deletions))
          )
        )
        if (open === change.path) {
          var body = patch === null ? t('working') : patch.patch
          if (patch !== null && patch.truncated) body += '\n' + t('truncated')
          rows.push(h('pre', { key: change.path + '#patch', className: 'fh-patch' }, body))
        }
      }
      if (entry.changes.length > MAX_ROWS) {
        rows.push(h('div', { key: '#more', className: 'fh-row fh-note' }, t('more') + ' ' + (entry.changes.length - MAX_ROWS)))
      }
      // 检查点这一行没有文件列表可看：它标的是某一版被留在那里，展开后只需要一句话和一颗按钮。
      if ((checkpointRow || pointer) && rows.length === 0) {
        rows.push(h('div', { key: '#note', className: 'fh-row fh-note' }, checkpointRow ? t('baselineBody') : t('nowBody')))
      }

      var head = [
        h('span', { key: 'caret', className: 'fh-caret' }, showList ? '▾' : '▸'),
        h('span', { key: 'title', className: 'fh-title' }, headTitle),
        checkpointRow ? null : h('span', { key: 'count', className: 'fh-stat' }, stats.files + ' ' + t('files')),
        checkpointRow ? null : h('span', { key: 'add', className: 'fh-add' }, '+' + stats.additions),
        checkpointRow ? null : h('span', { key: 'del', className: 'fh-del' }, '-' + stats.deletions)
      ]
      if (timeLabel !== '') head.push(h('span', { key: 'time', className: 'fh-time' }, timeLabel))
      if (entry.skipped > 0) {
        head.push(h('span', { key: 'skip', className: 'fh-note' }, t('skipped') + ' ' + entry.skipped))
      }
      // 降级是这一轮的额外事实：记录得不全，得让人看见，否则会当成那一轮什么都没改。
      if (entry.capped > 0) {
        head.push(h('span', { key: 'capped', className: 'fh-note' }, t('capped')))
      }
      // 太大的仓库整块没进快照，得点名说是哪几个目录，不然里面的改动缺席得毫无痕迹。
      if (entry.repos && entry.repos.length > 0) {
        head.push(h('span', { key: 'repos', className: 'fh-note' }, t('tooBig') + ' ' + entry.repos.join('、')))
      }

      var footer = []
      if (pointer) {
        // 「当前」行只说明现在和检查点差多少，还原的入口在检查点那一行。
      } else if (checkpointRow) {
        if (pending === null) {
          footer.push(h('button', { key: 'revert', className: 'fh-btn fh-btn-warn', disabled: busy, onClick: function () { setPending('checkpoint') } }, t('baselineRevert')))
        } else {
          footer.push(h('span', { key: 'ask', className: 'fh-note' }, t('baselineConfirm')))
          footer.push(h('button', { key: 'yes', className: 'fh-btn fh-btn-warn', disabled: busy, onClick: function () { run('checkpoint') } }, busy ? t('working') : t('confirm')))
          footer.push(h('button', { key: 'no', className: 'fh-btn', disabled: busy, onClick: function () { setPending(null) } }, t('cancel')))
        }
      } else if (pending === null) {
        // 父分支的轮次是只读的：快照虽然是同一棵，但线不在这里，要动它先跳过去。
        footer.push(h('button', { key: 'files', className: 'fh-btn', disabled: busy || crossLine, onClick: function () { setPending('files') } }, t('revertFiles')))
        footer.push(h('button', { key: 'chat', className: 'fh-btn', disabled: busy || crossLine, onClick: function () { setPending('chat') } }, t('revertChat')))
        footer.push(h('button', { key: 'both', className: 'fh-btn fh-btn-warn', disabled: busy || crossLine, onClick: function () { setPending('both') } }, t('revertBoth')))
        // 开分支不改这条线的任何记录，所以不用问，点了就走。
        footer.push(h('button', { key: 'branch', className: 'fh-btn', disabled: busy || crossLine, onClick: function () { run('branch') } }, t('branch')))
        if (crossLine) footer.push(h('span', { key: 'line', className: 'fh-note' }, t('crossLineHint')))
        if (undoable) footer.push(h('button', { key: 'undo', className: 'fh-btn', disabled: busy, onClick: undo }, t('undo')))
      } else {
        footer.push(h('span', { key: 'ask', className: 'fh-note' }, pending === 'files' ? t('confirmFiles') : pending === 'chat' ? t('confirmChat') : t('confirmBoth')))
        footer.push(h('button', { key: 'yes', className: 'fh-btn fh-btn-warn', disabled: busy, onClick: function () { run(pending) } }, busy ? t('working') : t('confirm')))
        footer.push(h('button', { key: 'no', className: 'fh-btn', disabled: busy, onClick: function () { setPending(null) } }, t('cancel')))
      }
      // 轮次卡片上可以把这一轮的状态存成检查点；时间线的「当前」行与检查点行本身没有这层含义。
      if (pending === null && !pointer && !checkpointRow) {
        footer.push(h('button', {
          key: 'baseline',
          className: 'fh-btn fh-btn-end',
          disabled: busy,
          onClick: function () {
            setBusy(true)
            setNotice(null)
            call('baseline', { sessionId: sessionId, action: 'set', tree: entry.tree })
              .then(function (value) {
                var skipped = value !== null && value !== undefined && value.skipped === true
                setNotice({ tone: skipped ? 'warn' : 'ok', text: skipped ? t('baselineNoChange') : t('baselineSaved') })
                onChanged()
              })
              .catch(function (error) {
                setNotice({ tone: 'error', text: String((error && error.message) || error) })
              })
              .then(function () { setBusy(false) })
          }
        }, t('baselineNew')))
      }

      // 三类卡片共用一套行结构，但外观各按自己的用途给：轮次是记录、检查点是被留下的那一版、当前是对照。
      var cardClass = 'fh-card' + (checkpointRow ? ' fh-card-chk' : pointer ? ' fh-card-now' : ' fh-card-turn')
      var footClass = 'fh-foot' + (checkpointRow ? ' fh-foot-end' : '')
      return h('div', { className: cardClass },
        h('div', { className: 'fh-head', onClick: toggleList }, head),
        showList ? h('div', { className: 'fh-body' }, rows) : null,
        footer.length === 0 || (footOnOpen && !showList && pending === null) ? null : h('div', { className: footClass }, footer),
        notice === null ? null : h('div', { className: notice.tone === 'error' ? 'fh-error' : 'fh-ok' }, notice.text)
      )
    }
    // 检查点相关的三颗按钮只写一遍，输入框上方的差异条、侧栏时间线、轮次卡片都从这里取，
    // 三处露出的文案与顺序因此天然一致。onDone 是该处自己的善后（刷新列表或重新取数）。
    function baseFooter(props) {
      var t = props.t
      var changed = props.changed === true
      var pending = props.pending === true
      var busy = props.busy === true
      function ask(action) {
        return function () { props.setAsk(action) }
      }
      if (pending) {
        return [
          h('span', { key: 'ask', className: 'fh-note' }, t('baselineConfirm')),
          h('button', { key: 'yes', className: 'fh-btn fh-btn-warn', disabled: busy, onClick: function () { props.run(props.ask) } }, busy ? t('working') : t('confirm')),
          h('button', { key: 'no', className: 'fh-btn', disabled: busy, onClick: function () { props.setAsk(null) } }, t('cancel'))
        ]
      }
      var bar = []
      if (changed) {
        // 「设为检查点」把这会儿的差异一并收进检查点，磁盘不动；「还原到检查点」反过来，
        // 把磁盘拉回检查点。一个是收下现状，一个是回到旧态，所以并排放。
        bar.push(h('button', { key: 'set', className: 'fh-btn', disabled: busy, onClick: function () { props.run('set') } }, t('baselineNew')))
        bar.push(h('button', { key: 'revert', className: 'fh-btn fh-btn-warn', disabled: busy, onClick: ask('revert') }, t('baselineRevert')))
      }
      return bar
    }

    // 输入框上方的改动条：照官方任务条的做法——一行标题 + 空格 + 右侧 chevron，
    // 整个头行就是按钮，不再单独摆按钮。展开后看差异，还原/更新收在底部。
    function Baseline(props) {
      var t = props.t
      var call = props.call
      // 输入框上方这一格在新建会话页也照样被渲染，宿主给不出会话。空会话没有检查点，
      // 也就没有可显示的差异——直接不起，不去借别处的会话。
      var sessionId = props.sessionId
      if (sessionId === undefined || sessionId === null || sessionId === '') return null
      // 这条只用一份数据：检查点和磁盘现状的差异。它不是轮次清单的子集，所以不并进共用取数，自己拿。
      var diffState = React.useState(null)
      // 切会话的那一瞬间，上一份结果还挂在 state 里：只认当前会话那一份，绝不借别人的差异来显示。
      var fetched = diffState[0]
      var diff = fetched !== null && fetched.sessionId === sessionId ? fetched.value : null
      function setDiff(value) { diffState[1]({ sessionId: sessionId, value: value }) }
      var reloadState = React.useState(0)
      var reload = reloadState[0]
      var setReload = reloadState[1]
      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var askState = React.useState(null)
      var ask = askState[0]
      var setAsk = askState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var noticeState = React.useState(null)
      var notice = noticeState[0]
      var setNotice = noticeState[1]
      // 「文件停在哪条分支」是账本里的一格，跟时间线、轮次卡共用同一份取数，不为它再要一次。
      var store = useStore(call, sessionId)

      // 差一份数据、只在这条显示时才需要，所以取数也写在这里：装载、轮次结束、自己动过之后各一次。
      React.useEffect(function () {
        var alive = true
        call('baseline', { sessionId: sessionId }).then(function (value) {
          if (alive) setDiff(value || {})
        }, function (error) {
          if (alive) setDiff({ notice: String(error && error.message ? error.message : error) })
        })
        function bump() { setReload(function (n) { return n + 1 }) }
        var off = onTurnEnd(bump)
        // 别处动了磁盘或检查点也要重算：轮次卡上设定检查点、还原、撤销还原、清除历史都会喊这一声。
        var offDisk = onDiskChange(bump)
        return function () {
          alive = false
          off()
          offDisk()
        }
      }, [sessionId, reload])

      async function run(action) {
        setBusy(true)
        setNotice(null)
        try {
          var value = await call('baseline', { sessionId: sessionId, action: action })
          if (action === 'revert') {
            setNotice({ tone: 'ok', text: t('baselineDone') + ' · ' + t('written') + ' ' + value.written + ' · ' + t('removed') + ' ' + value.removed })
          } else {
            var skipped = value !== null && value !== undefined && value.skipped === true
            setNotice({ tone: skipped ? 'warn' : 'ok', text: skipped ? t('baselineNoChange') : t('baselineSaved') })
          }
          setAsk(null)
          // 检查点两边共用：重读账本，改动条自己也重算一次差异。
          reloadSession(call, sessionId)
        } catch (error) {
          setNotice({ tone: 'error', text: String((error && error.message) || error) })
        }
        setBusy(false)
      }

      // 文件已经被同族另一条分支改走：本线的差异条说的是旧位置，先把这件事指出来，
      // 按钮直接跳过去——分支就是会话，跳转不动磁盘。
      var jump = store === null || store === undefined || !store.elsewhere ? null : store.elsewhere
      var jumpCard = jump === null ? null : h('div', { className: 'fh-card fh-base fh-jump' },
        h('div', { className: 'fh-head' },
          h('span', { key: 'title', className: 'fh-title' }, t('elsewhereTitle')),
          h('button', { key: 'go', className: 'fh-btn fh-btn-end', onClick: function () { if (props.uiWorkspace) props.uiWorkspace.openSession(jump.sessionId) } }, t('elsewhereGo'))))

      if (diff === null) return jumpCard
      // 拿不到 git 就什么都记不了：这条顶在输入框上方，和别的提示同一个样式。
      if (diff.notice === 'git-unavailable') {
        return h('div', { className: 'fh-card fh-base' }, h('div', { className: 'fh-head fh-warn' },
          h('span', { className: 'fh-title' }, t('gitMissing'))))
      }

      var stats = diff.stats
      var hasBase = diff.baseline !== null && diff.baseline !== undefined
      var changed = stats && stats.files > 0
      // 这条只是「当前与检查点的差异」提示：没有检查点、或两者没有区别，都不出现。
      if (!hasBase || !changed) return jumpCard

      var head = [
        h('span', { key: 'title', className: 'fh-title' }, t('diffTitle')),
        h('span', { key: 'count', className: 'fh-stat' }, stats.files + ' ' + t('files')),
        h('span', { key: 'add', className: 'fh-add' }, '+' + stats.additions),
        h('span', { key: 'del', className: 'fh-del' }, '-' + stats.deletions),
        h('span', { key: 'chevron', className: 'fh-chevron' }, open ? '▴' : '▾')
      ]
      var rows = []
      if (open) {
        var list = diff.changes || []
        for (var i = 0; i < list.length; i += 1) {
          var change = list[i]
          var marker = change.kind === 'added' ? 'A' : change.kind === 'deleted' ? 'D' : 'M'
          rows.push(h('div', { key: change.path, className: 'fh-row fh-row-flat' },
            h('span', { className: 'fh-kind' }, marker),
            h('span', { className: 'fh-path' }, change.path),
            change.binary
              ? h('span', { className: 'fh-stat' }, t('binary'))
              : h('span', { className: 'fh-stat' },
                h('span', { className: 'fh-add' }, '+' + change.additions), ' ',
                h('span', { className: 'fh-del' }, '-' + change.deletions))))
        }
        if (list.length === 0) rows.push(h('div', { key: '#none', className: 'fh-row fh-note fh-row-flat' }, t('empty')))
      }

      var footer = baseFooter({ t: t, changed: changed, pending: ask !== null, ask: ask, busy: busy, setAsk: setAsk, run: run })

      var bar = h('div', { key: 'bar', className: 'fh-card fh-base' },
        h('div', { className: 'fh-head', onClick: function () { setOpen(!open) } }, head),
        open ? h('div', { className: 'fh-body' }, rows) : null,
        h('div', { className: 'fh-foot' }, footer),
        notice === null ? null : h('div', { className: notice.tone === 'error' ? 'fh-error' : notice.tone === 'warn' ? 'fh-warn' : 'fh-ok' }, notice.text)
      )
      return jumpCard === null ? bar : h('div', { className: 'fh-stack' }, jumpCard, bar)
    }

    function timeText(time) {
      if (typeof time !== 'number' || time <= 0) return ''
      var date = new Date(time)
      return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
    }

    // 侧栏是一条时间线：最上面是「当前」，往下按时间倒序排检查点和每一轮。节点自带圆点，
    // 轮次直接复用会话区那张卡片，两处看到的图标、按钮、文案因此完全一致。
    function Panel(props) {
      var t = props.t
      var call = props.call
      var uiWorkspace = props.uiWorkspace
      var sessionId = props.sessionId
      var data = useStore(call, sessionId)
      // 清理是一次性的动作，三样状态放一处：正在问哪一档、是否在跑、上次为什么失败。
      var clearState = React.useState({ ask: null, busy: false, error: null })
      var clearUi = clearState[0]
      var setClear = clearState[1]


      if (data === null) return h('div', { className: 'fh-panel' }, h('div', { className: 'fh-panel-empty' }, t('working')))
      if (data.notice === 'git-unavailable') return h('div', { className: 'fh-panel' }, h('div', { className: 'fh-panel-empty fh-warn' }, t('gitMissing')))
      // 快照没拍成要直说原因，否则界面上看起来就是「什么都没发生」。
      var failure = data.notice === null || data.notice === undefined || data.notice === 'git-unavailable' ? null : String(data.notice)

      var entries = data.entries || []
      var rest = []
      var kept = data.baselines || []
      for (var b = 0; b < kept.length; b += 1) rest.push({ kind: 'baseline', time: kept[b].time, at: b, tree: kept[b].tree, source: kept[b].source })
      // 早期版本把没有改动的轮次也记了账，这里一并滤掉，时间线只留真的动过文件的轮次。
      for (var i = 0; i < entries.length; i += 1) {
        if (entries[i].stats && entries[i].stats.files === 0) continue
        rest.push({ kind: 'turn', time: entries[i].time, entry: entries[i] })
      }
      rest.sort(function (a, b) { return b.time - a.time })
      var newest = null
      for (var j = 0; j < rest.length; j += 1) {
        if (rest[j].kind === 'turn') { newest = rest[j]; break }
      }

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
            sum: item.source === 'origin' ? t('baselineOriginHint') : item.source === 'fork' ? t('baselineForkHint') : item.at === 0 ? t('baselineSavedHint') : t('baselineOlderHint'),
            entryProps: {
              t: t,
              sessionId: sessionId,
              openByDefault: true,
              call: call,
              checkpointRow: true,
              // 每个检查点都能还原，还原到的是这一行代表的那一版。
              tree: item.tree,
              entry: { changes: [], stats: { files: 0, additions: 0, deletions: 0 } },
              headTitle: t('baseline'),
              onChanged: function () { reloadSession(call, sessionId) }
            }
          }))
          continue
        }
        var entry = item.entry
        rows.push(h(TLine, {
          key: entry.id,
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
            undo: typeof data.undo === 'boolean' && data.undo === true && item === newest,
            uiWorkspace: uiWorkspace,
            headTitle: t('turnLabel') + ' ' + entry.turn + ' ' + t('turnUnit'),
            onChanged: function () { reloadSession(call, sessionId) },
          }
        }))
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
          setClear({ ask: scope, busy: false, error: String((error && error.message) || error) })
          // 回收失败时记录也已经清了，界面得跟着走，别停在清空前的样子。
          reloadSession(call, sessionId)
        }
      }

      var clearRows = []
      if (clearUi.ask === null) {
        clearRows.push(h('button', { key: 'turns', className: 'fh-btn', onClick: function () { setClear({ ask: 'turns', busy: false, error: null }) } }, t('clearTurns')))
        clearRows.push(h('button', { key: 'all', className: 'fh-btn fh-btn-warn', onClick: function () { setClear({ ask: 'all', busy: false, error: null }) } }, t('clearAll')))
      } else {
        clearRows.push(h('span', { key: 'ask', className: 'fh-note' }, clearUi.ask === 'all' ? t('clearAllConfirm') : t('clearTurnsConfirm')))
        clearRows.push(h('button', { key: 'yes', className: 'fh-btn fh-btn-warn', disabled: clearUi.busy, onClick: clearHistory }, clearUi.busy ? t('working') : t('clearGo')))
        clearRows.push(h('button', { key: 'no', className: 'fh-btn', disabled: clearUi.busy, onClick: function () { setClear({ ask: null, busy: false, error: null }) } }, t('cancel')))
      }

      return h('div', { className: 'fh-panel' },
        h('div', { className: 'fh-tl' }, rows),
        rest.length === 0 ? null : h('div', { className: 'fh-foot' }, clearRows),
        clearUi.error === null ? null : h('div', { className: 'fh-error' }, clearUi.error),
        failure === null ? null : h('div', { className: 'fh-error' }, failure))
    }

    // 时间线上一行 = 时间 · 标题 · 摘要 · 增删：平时只有一行，点开才展开完整的改动卡片。
    // 必须是组件而不能是普通函数：行内要用 useState 记住展开状态。
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
      // 不把「轮次就一定轻」写死——当前停在某一轮时，那一轮要跟着重起来，否则标签和尺寸对不上。
      var role = props.current === true ? 'current' : (props.special === true ? 'checkpoint' : 'turn')
      var rowClass = 'fh-tl-row fh-tl-row-' + role + (props.foreign === true ? ' fh-tl-row-foreign' : '')
      return h('div', { className: rowClass },
        h('span', { className: 'fh-tl-dot ' + (props.current === true ? 'fh-tl-dot-now' : (props.dotClass || '')) }, props.foreign === true ? h('i', { key: 'ring' }) : null),
        h('div', { className: 'fh-node', onClick: function () { setOpen(!open) } },
          h('span', { className: 'fh-node-time' }, timeText(props.time)),
          h('span', { className: 'fh-node-title' }, props.title),
          // 「当前」是一枚指针标记，不是说还有另一个节点：它贴在哪个节点上，当前就停在哪一格。
          props.current === true ? h('span', { className: 'fh-node-now' }, t('now')) : null,
          h('span', { className: 'fh-node-sum' }, sum),
          stat,
          h('span', { className: 'fh-chevron' }, open ? '▴' : '▾')),
        open ? h(Entry, props.entryProps) : null)

    }

    function Card(props) {
      var t = props.t
      var call = props.call
      var uiWorkspace = props.uiWorkspace
      var sessionId = props.sessionId
      var raw = props.matched !== undefined ? props.matched : props.turn
      var turn = raw !== null && typeof raw === 'object' ? raw.turn : raw
      // 它要的那一行是共用数据里轮次清单的子集，所以不自己拉：这一轮还没记账就先不渲染，
      // 轮次结束那次取数会把这一行带回来，卡片随之出现。
      var data = useStore(call, sessionId)

      if (data === null) return null
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
      if (found === null || !found.stats || found.stats.files === 0) return null
      return h(Entry, {
        t: t,
        call: call,
        sessionId: sessionId,
        entry: found,
        undo: data.undo === true && found === newest,
        uiWorkspace: uiWorkspace,
        headTitle: t('title'),
        baseline: data.baseline !== null && data.baseline !== undefined,
        timeLabel: timeText(found.time),
        openByDefault: true,
        onChanged: function () { reloadSession(call, sessionId) }
      })
    }
    // 设置页里的那张卡。命名空间跟宿主注册的那个一样，值也只有一份：
    // 卡片改完，宿主那边下一轮读到的就是新值，不必重启。
    var SETTINGS_NS = 'dsh-file-history'
    // 按常用程度从上往下排：三个界面开关在前，数量类在后。
    // factor 是把界面上显示的单位换成存储单位的倍数——字节的东西按 MB 给人看。
    var FIELDS = [
      { key: 'turnCard', type: 'bool', label: 'setTurnCard', hint: 'hintTurnCard' },
      { key: 'dock', type: 'bool', label: 'setDock', hint: 'hintDock' },
      { key: 'timeline', type: 'bool', label: 'setTimeline', hint: 'hintTimeline' },
      { key: 'keepRecentTurns', type: 'num', label: 'setKeep', hint: 'hintKeep', unit: 'setUnitTurn', min: 0, max: 1000, step: 1 },
      { key: 'maxFileBytes', type: 'num', label: 'setFileSize', hint: 'hintFileSize', unit: 'setUnitMB', min: 0, max: 1024, step: 1, factor: 1048576 },
      { key: 'maxRepoFiles', type: 'num', label: 'setRepoFiles', hint: 'hintRepoFiles', unit: 'setUnitPiece', min: 0, max: 1000000, step: 1000 },
      { key: 'maxBytes', type: 'num', label: 'setTotal', hint: 'hintTotal', unit: 'setUnitMB', min: 0, max: 1048576, step: 256, factor: 1048576 },
      { key: 'pruneAfterCheckpoints', type: 'num', label: 'setPrune', hint: 'hintPrune', unit: 'setUnitPiece', min: 0, max: 100, step: 1 }
    ]

    // 快照是客户端这边的镜像：订阅一次，宿主一提交再取一份。引用没变就不重渲染。
    function useSettingsSnapshot(scope) {
      var pair = React.useState(function () { return scope ? scope.getSnapshot() : null })
      var snapshot = pair[0]
      var setSnapshot = pair[1]
      React.useEffect(function () {
        if (!scope) return undefined
        setSnapshot(scope.getSnapshot())
        return scope.subscribe(function () { setSnapshot(scope.getSnapshot()) })
      }, [scope])
      return snapshot
    }

    // 读不到（还没送到、或这边没有设置通道）就当开着：插件默认是三个界面都在。
    function flagOf(snapshot, key) {
      if (!snapshot || snapshot.status !== 'ready' || !snapshot.value) return true
      return snapshot.value[key] !== false
    }

    // 关掉时不光不渲染，连注册一起撤掉：留个空槽比不注册更难看。开关一变就重挂一次。
    function whenShown(scope, key, setup) {
      var dispose = null
      function sync() {
        var on = scope === null ? true : flagOf(scope.getSnapshot(), key)
        if (on && dispose === null) {
          dispose = setup() || function () {}
        } else if (!on && dispose !== null) {
          var stop = dispose
          dispose = null
          stop()
        }
      }
      sync()
      var off = scope === null ? null : scope.subscribe(sync)
      return function () {
        if (off !== null) off()
        if (dispose !== null) dispose()
      }
    }

    function BoolRow(props) {
      var t = props.t
      var failed = React.useState(false)
      var busy = React.useState(false)
      function flip(next) {
        busy[1](true)
        failed[1](false)
        Promise.resolve(props.scope.set(props.field.key, typeof next === 'boolean' ? next : !props.value))
          .catch(function () { failed[1](true) })
          .then(function () { busy[1](false) })
      }
      return h('div', { className: 'fh-set-field' },
        h('div', { className: 'fh-set-row' },
          h('span', { className: 'fh-set-label' }, t(props.field.label)),
          Switch
            ? h(Switch, { checked: props.value, disabled: busy[0], label: t(props.field.label), onChange: flip })
            : h('button', {
                type: 'button',
                role: 'switch',
                'aria-checked': props.value,
                className: 'fh-sw' + (props.value ? ' fh-sw-on' : ''),
                disabled: busy[0],
                onClick: function () { flip(!props.value) }
              }, h('span', { className: 'fh-sw-dot' })),
          failed[0] ? h('span', { className: 'fh-error' }, t('saveFailed')) : null),
        h('p', { className: 'fh-set-hint' }, t(props.field.hint)))
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
      return h('div', { className: 'fh-set-field' },
        h('div', { className: 'fh-set-row' },
          h('span', { className: 'fh-set-label' }, t(field.label)),
          h('span', { className: 'fh-set-input' },
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
            h('span', { className: 'fh-set-unit' }, t(field.unit))),
          failed[0] ? h('span', { className: 'fh-error' }, t('saveFailed')) : null),
        h('p', { className: 'fh-set-hint' }, t(field.hint)))
    }

    function SettingsCard(props) {
      var t = props.t
      var scope = props.scope
      var snapshot = useSettingsSnapshot(scope)
      // 宿主还没把这一份发下来时整张卡不出现，免得先亮一排默认值再跳一次。
      if (!scope || snapshot === null || snapshot.status !== 'ready' || !snapshot.value) return null
      var value = snapshot.value
      // 跟官方那张插件卡一样先折着：一页里可能有好几个插件，摊开会很长。
      var open = React.useState(false)
      return h('div', { className: 'fh-set' + (open[0] ? ' fh-set-open' : '') },
        h('button', {
          type: 'button',
          className: 'fh-set-head',
          'aria-expanded': open[0],
          onClick: function () { open[1](!open[0]) }
        },
          h('span', { className: 'fh-set-headText' },
            h('span', { className: 'fh-set-name' }, t('panelTitle')),
            h('span', { className: 'fh-set-desc' }, t('setDesc'))),
          h('span', { className: 'fh-chev' + (open[0] ? ' fh-chev-open' : '') }, IconChevron ? h(IconChevron) : '▾')),
        open[0]
          ? h('div', { className: 'fh-set-body' }, h('div', { className: 'fh-set-rows' }, FIELDS.map(function (field) {
              return field.type === 'bool'
                ? h(BoolRow, { key: field.key, t: t, scope: scope, field: field, value: value[field.key] !== false })
                : h(NumRow, { key: field.key, t: t, scope: scope, field: field, value: value[field.key] })
            })))
          : null)
    }

    function apply(ctx) {
      var slots = ctx.slots || ctx.get('slots')
      var locale = ctx.locale || ctx.get('locale')
      var connection = ctx.connection || ctx.get('connection')
      var uiWorkspace = ctx.get('uiWorkspace')
      if (!connection) return

      var styles = ctx.get('styles')
      if (styles && typeof styles.insert === 'function') {
        styles.insert(CSS)
      } else if (typeof document !== 'undefined') {
        var tagId = 'dsh-file-history/card.css'
        if (document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
          var tag = document.createElement('style')
          tag.setAttribute('data-plugin', 'dsh-file-history')
          tag.setAttribute('data-plugin-css', tagId)
          tag.textContent = CSS
          document.head.appendChild(tag)
        }
      }

      if (locale && typeof locale.register === 'function') {
        ctx.effect(function () {
          return locale.register(NS, { zh: ZH, en: EN })
        }, 'dsh-file-history: dictionaries')
      }

      var t = locale && typeof locale.bind === 'function' ? locale.bind(NS) : function (key) { return key }

      // 设置页的那张卡和三个界面开关共用这一份：宿主注册的命名空间，客户端这边只是镜像。
      var settingsScope = ctx.settingsScope || ctx.get('settingsScope')
      var settings = settingsScope && typeof settingsScope.bind === 'function' ? settingsScope.bind({ namespace: SETTINGS_NS }) : null

      async function call(endpoint, payload) {
        var result = await connection.rpc.call(CHANNEL, endpoint, payload)
        if (!result || result.ok !== true) {
          throw new Error(result && result.error ? result.error.message : 'request failed')
        }
        return result.value
      }
      // 设置页里的一张卡：宿主注册了这个命名空间，卡片才会出现在插件列表里。
      if (slots && settings) {
        ctx.effect(function () {
          return slots.inject('settings.plugin.item', function () {
            return slots.register(
              {
                name: 'settings.plugin.item',
                key: SETTINGS_NS,
                locale: NS
              },
              function () {
                return h(SettingsCard, { t: t, scope: settings })
              }
            )
          })
        }, 'dsh-file-history: settings card')
      }

      if (slots && ctx.sidebarRightTabs) {
        // 时间线关掉时，标签类型和面板一起撤：只撤面板会留下一个空标签。
        ctx.effect(function () {
          return whenShown(settings, 'timeline', function () {
            var unTab = ctx.sidebarRightTabs.register({
              id: TAB_ID,
              kind: TAB_ID,
              priority: 'extension',
              title: function () { return t('panelTitle') },
              guide: [{
                order: 15,
                title: function () { return t('panelTitle') },
                description: function () { return t('panelDesc') },
                icon: IconClock || undefined
              }]
            })
            var unBody = slots.inject('sidebar.right.pane.tab', function () {
              return slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: TAB_ID,
                  locale: NS,
                  inject: function (sessionId) { return { sessionId: sessionId } }
                },
                function (props) {
                  return h(Panel, {
                    t: t,
                    call: call,
                    uiWorkspace: uiWorkspace,
                    sessionId: props.sessionId
                  })
                }
              )
            })
            return function () {
              unBody()
              unTab()
            }
          })
        }, 'dsh-file-history: tab')
      }

      if (slots) {
        ctx.effect(function () {
          return whenShown(settings, 'turnCard', function () {
          return slots.inject('conversation.chat.turnTail', function () {
            return slots.register(
              {
                name: 'conversation.chat.turnTail',
                // 轮次未结束时也返回 turn：卡片先挂上，宿主在 turn/end 写入快照后
                // 卡片自己就会更新，不必靠刷新页面重建聊天事件。
                select: function (owner) {
                  if (!owner || !owner.turn) return null
                  return owner.turn.turn
                }
              },
              function (props) {
                var closed = props.turn !== undefined && props.turn !== null && props.turn.status === 'closed'
                // 每轮闭合广播一次：dock 条和侧栏面板靠这个信号刷新，自己不轮询。
                React.useEffect(function () {
                  if (closed) fireTurnEnd(props.turn)
                }, [closed, props.sessionId, props.turn])
                return h(Card, {
                  t: t,
                  call: call,
                  uiWorkspace: uiWorkspace,
                  sessionId: props.sessionId,
                  turn: props.matched
                })
              }
            )
          })
          })
        }, 'dsh-file-history: turn tail')
      }

      if (slots && typeof slots.inject === 'function') {
        ctx.effect(function () {
          return slots.inject('conversation.input.dock', function () {
            return slots.register(
              {
                name: 'conversation.input.dock',
                id: 'file-history-baseline',
                order: 10,
                label: function () { return t('baseline') }
              },
              function (props) {
                return h(Baseline, { t: t, call: call, uiWorkspace: uiWorkspace, sessionId: props.sessionId })
              }
            )
          })
        }, 'dsh-file-history: baseline bar')
      }
    }

    exports.name = 'dsh-file-history'
    exports.inject = ['connection', 'locale', 'slots', 'sidebarRightTabs', 'settingsScope']
    exports.apply = apply
    return module.exports
  }
})
