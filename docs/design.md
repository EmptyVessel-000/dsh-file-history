# File History 设计文档

> 工作区文件历史 / Workspace File History
> 包名：`dsh-file-history`　插件标识：`file-history`　界面名：文件历史 / File History
> 适用：DSH 0.1.7-rc.2 及以上

前提：只看 DSH 0.1.7-rc.2+ 现在给的接口与设计规范，决定它该长什么样。

## 一、先说清楚还剩什么可做

官方 `dsh-workspace-changes` 已经做了这些：

- `turn/start` 用 git 树给整个仓库起点快照，`turn/end` 前再拍一次；shell 改动、外部编辑器改动都在内（非 git 目录退化为只看文件工具）。
- 每轮的逐文件 before/after 内容、增删行数，通过客户端路由 `/api/changes.summary`、`/api/changes.diff`、`/api/changes.open` 提供。
- 会话内提供宿主服务 `ctx.workspaceChanges.summary(sessionId, seq)` 与 `.diff(sessionId, seq, index, signal)`。
- 展示落点是 `conversation.chat.turnTail` 那张卡，以及工具卡的 diffs。
- 记录只在内存与临时目录，会话 `session/disposed` 即丢。

它没做的事，也就是这个插件唯一该做的事：

1. 把快照留下来（跨会话、跨进程、跨重启），而不是这一轮结束就没了。
2. 按整棵**会话树**保留可回退的检查点：开头、分支点、手动标的点。
3. 真正把文件写回某一版；写回前先确认工作区是否被外部改过。
4. 撤销这一轮的改动：退回到这一轮开始前的那一版。
5. 非 git 工作区也能用（自己的影子仓库，不看用户项目的 .git）。
6. 体积有上限、旧轮次会裁剪、占用看得见。

不做的：重画每轮文件清单、自己做 diff 预览、替代 git 的提交/分支/暂存区、代码审查。

## 二、官方接口盘点（本机 0.1.7-rc.3 实测）

### 宿主侧

| 接口 | 用途 | 注意 |
| --- | --- | --- |
| `ctx.sessions.get(id)` / `.list()` | 活会话对象 | header 可能不带 cwd（懒加载/恢复） |
| `ctx.workspaceRegistry.readSessionHeader(id)` | 权威会话头：cwd、parentSession、origin | 侧栏工作区分组就按它；拿 cwd 只该用这一个来源 |
| `workspaceRegistry.list()`、`entity.attachSession(id)` | 工作区实体与成员 | fork 出来的新会话必须 attach，否则侧栏不属于任何工作区 |
| `ctx.sessions.fork(source, boundary)` | 从某个序号切出新会话 | boundary 只能落在没有开着轮次的位置；它只把 cwd 复制进新会话头 |
| `session.header.parentSession` + `session.inheritedEventCount` | 认分歧点 | fork 把继承前缀的事件条数写进子会话；数前缀里最后一个 `turn/end` 就知道切在第几轮，不必另存分支表，重启也不丢 |
| `workspaceRegistry.archiveSession(id)` | 归档会话 | 「还原文件和会话」用它把原会话收起来；它只隐藏、不截断，会话正忙时抛 `WorkspaceActiveSessionError` |
| `ctx.on('session/event')` | `turn/start`、`turn/end`、`tool/result`… | 每轮起止的唯一可靠信号 |
| `ctx.on('session/disposed')` | 会话销毁 | 官方 change 插件用它释放记录器；我们也该用它收尾 |
| `ctx.on('loader/volatile-update')` | 配置热更新 | volatile 字段原地写回，不重启 |
| `ctx.workspaceChanges.summary/diff` | 官方这一轮的改动摘要 | 只覆盖本轮与内存期，不能当持久历史用 |

### 客户端侧

| 接口 | 用途 |
| --- | --- |
| `configForms.get(entryId)` → `{getSnapshot, subscribe, set, unset}` | 插件配置表单 |
| 槽 `settings.plugins.tab` | 设置页里属于本插件的一页 |
| 槽 `conversation.chat.turnTail` | 每条回复下方的附加区（官方卡片也在这里，我们只放按钮行） |
| 槽 `conversation.input.dock` | 输入框上方（没有内容就不许出现） |
| `sidebarRightTabs.register` + 槽 `sidebar.right.pane.tab` | 右侧栏的一个标签 |
| `@deepseek-ai/dsh-client-ui-primitives` | `Switch`、`IconClockOutlineRegular` 等官方控件 |
| `locale.register/bind` | 文案 |

### 本插件对客户端暴露的接口（通道 `/dsh-file-history`）

五个端点，读的归读、写的归写，一个名词对应一组动作：

| 端点 | 职责 | 说明 |
| --- | --- | --- |
| `state` | 读一切：时间线、检查点、树设置、占用、最后一次动盘在哪条线 | 带 `turn` 时先等这一轮落账；带 `diff: true` 才真扫盘算「当前与最新检查点的差异」 |
| `restore` | 把工作区写回某一版 | `mode`：files / chat / both / branch / undo；`undo` 的落点是本线最末一条记录的 `base` |
| `point` | 检查点的三个动作 | `action`：set / revert / delete |
| `config` | 开关、规则、留几轮 | 写在树根上，整棵树共用 |
| `clear` | 清轮次 / 清全部 | `scope`：turns / all |

### 设计规范（已实测的数值）

- 面板内分割线 `.5px solid var(--dsw-alias-border-l3)`；设置行之间是 `border-l2`。
- 输入框 34px 高、圆角 8、`border-l4`、底色 `bg-layer-3`，聚焦 `brand-primary`。
- 按钮：次要 = 1px `border-l2` 描边 + 透明底 + 13px/1.5 + radius 8 + `padding: 5px 14px`；主操作 = 实心 `label-primary` 底、`bg-layer-3` 字。
- 标题 15px/600，说明 13px + `label-tertiary`。

## 三、动作时机（只在这些点上动）

1. **turn/end**：给这个会话拍一次整树快照，记一行。
2. **用户显式动作**：设为检查点、还原（文件/对话/两者）、从这一轮开分支、撤销此轮更改、清除历史、改设置。
3. **设置变更**：只写配置、作废上一轮留在内存里的扫描结果；不扫盘。
4. **session/disposed**：释放这个会话的内存状态（等待者、起点树）。

除此之外不扫盘、不定时器、不轮询。启动时也不预热任何工作区。

## 四、数据模型

每个工作区一个账本目录：`$DSH_HOME/dsh-file-history/<sha256(规范化 cwd)>/`

- `repo.git`：影子裸仓库，只存树与提交（`refs/lines/<sessionId>`、`refs/checkpoints/<tree>`）。
- `index.json`：三层。**全局**在插件配置里（上限与 git 路径）；**树**放配置，**会话**放数据，谁需要全树视图就沿父链组合。

  ```json
  {
    "version": 3,
    "big": [],
    "trees": { "<树根 id>": { "off": false, "auto": true, "keep": 20, "excludes": [], "allow": [] } },
    "lines": { "<会话 id>": { "turn": { "738": { … } }, "point": { "<tree>": { … } }, "blank": { "739": 1729… } } }
  }
  ```

  - `trees[根] = { off, auto, keep, excludes, allow }`：关掉、每轮自动拍、保留轮次、排除与允许规则。同一棵树里的会话读同一份。
  - `lines[会话].turn[轮次] = { time, startSeq, endSeq, base, tree, commit, changes, skipped, capped, repos }`：轮次直接以轮次号作键，数字键天然升序，取最新、裁剪都只碰键。会话 id 与轮次号都在键里，不抄进记录；`stats` 由 `changes` 现算，也不落盘（读的时候 `hydrate()` 补齐这三样）。`skipped`/`capped` 是一个数，不是对象。
  - `lines[会话].point[tree] = { turn, time, seq, source: origin|manual|fork, entry? }`：检查点由谁创建就记在谁名下（会话 id 不再抄进点里，读的时候由外层键补上），对整棵树有效；同一棵树重复设点只留一份。`entry` 只有手动点有：一个轮次只对应一个点，设点后那条轮次记录整份挂到这里，界面上两种点才长得一样；开头点与分支点没有对应轮次，也就不带 `entry`。
  - `lines[会话].blank[轮次] = time`：扫过、但文件没有改动的轮次。只记轮次与时间，不存树与差异；靠它把「没变」和「没扫」（自动快照关着）区分开。
  - `big`：判定为过大的文件清单，是磁盘事实，所有树共用，挂在顶层。
- 版本号对不上就从空账本重来：不再写迁移代码（老账本直接作废，能丢的都是可以从磁盘重新拍出来的记录）。

没有差异的轮次不落行（空条目没有信息量）；但骨架（线引用、开头点）照常维护。

## 五、界面（四处，各有各的唯一职责）

1. **轮次动作行**（`conversation.chat.turnTail`，官方文件清单卡片的下方）：只放动作，不放文件清单——清单归官方。动作：设为检查点 / 只还原文件 / 只还原对话 / 两者一起 / 从这一轮开分支 / 撤销。有快照的轮次给全套（设为检查点、还原文件、还原对话、两者一起、开分支、撤销）；被设成检查点的那一轮仍是同一套，只把「设为检查点」换成「删除」；扫过但没改动的轮次只给「设为检查点」；没扫过的轮次（自动拍快照关着）一颗都不给。对话与时间线两处是同一套按钮——时间线只是同一份记录的缩影。
2. **输入框上方差异条**（`conversation.input.dock`）：只干一件事——当前状态与上个检查点的差异。没有检查点或没有差异时整条不出现；有差异时显示文件数与增删，展开是文件列表，footer 是「设为新的检查点」与「还原到上个检查点」。
3. **右侧栏标签**（`sidebarRightTabs` + `sidebar.right.pane.tab`）：上 2/3 时间线（检查点与轮次排在一起，点一行展开动作），下 1/3 这棵树与这条会话的设置（开关、允许/排除规则、留几轮、两个清理入口、占用）。
4. **设置页一页**（`settings.plugins.tab`）：插件级默认值（三个界面开关、上限），改完下一轮生效。

文案与控件全部走 locale 与 primitives；自绘只用样式表，不重造 Switch。

## 六、交互语义

- **还原文件**：把磁盘写到目标树（会删掉该树里没有的文件）。写盘前比对该会话最后一条记录与当前磁盘，若外部改过 `N` 个文件，先问「N 个文件在记录之后被外面改过，仍要覆盖？」。
- **还原对话**：不切原会话，而是 `ctx.sessions.fork(source, 这一轮结束后的序号)`——「到此处」这一轮算在内，新会话里有它；文件不动，新线的起点取磁盘现在这一版。
- **从这一轮开分支**：文件回到该轮结束的样子，对话切在该轮之后，切过去继续；原会话留着。
- **还原文件和会话**：写盘与分支相同，另外把原会话归档（`workspaceRegistry.archiveSession`）——宿主没有截断会话的接口，归档是唯一能让侧栏"只剩回来这一条"的办法。会话正忙时归档会被拒（`WorkspaceActiveSessionError`），这时照常保留原会话，并在成功提示里说明没归档成。
- **撤销此轮更改**：落点是记录里的 `base`，也就是这一轮对话开始前那一版——两轮之间你手改过的东西留着，只退掉这一轮带来的改动；不靠往前找上一条，更早的行被裁掉也照样能退。只挂在最末一条记录上。`base` 不进历史链、也不是提交给它：靠一条 `refs/temp/base` 钉住最新那份（撤销只挂最末一条，更早的没人再用），裁剪后的 `prune --expire=now` 就收不走它。
- **设检查点**：一个轮次只对应一个点——这一轮有快照时，快照换成检查点（父树、起止序号、统计与逐文件改动一并抄过去，卡片照旧全长），同一轮不会既是轮次行又是检查点行；这一轮没有改动时，把往前能溯源的最近一份快照（先自己这条线，再祖先分叉前那一版）复制成本轮的检查点；溯源断了就拒绝并说明做不了。已经是检查点的位置把「设为检查点」换成「删除」，删除会把检查点里的字段还原成快照，这一轮的记录不会凭空消失。
- **关掉文件历史**：作用于整棵会话树；关掉后不拍、不记、不显示差异条，已记的轮次照旧可看可还原。
- **自动拍快照关掉**：只在检查点上记录；这条线没有检查点时补一个开头点。
- **裁剪**：两项同时生效，都满足才留下——最近 M 轮（`keep`）是一道路径，倒数第 N 个检查点（`prune`）之前的一律删；任一项设 0 表示那一道不管。

## 七、错误与降级

- 每个失败都要说人话：拿不到工作区 cwd、git 不可用、仓库初始化失败、扫盘超时，全部把原始 message 传上去，不折叠成一句笼统提示。
- 影子仓库只有 HEAD 缺失时才算坏；坏就整个目录清掉重建（半截目录会让 `git init` 永久失败）。
- 单个文件或仓库太大就跳过，并在那一行注明跳过了多少、哪些仓库整块没记。
