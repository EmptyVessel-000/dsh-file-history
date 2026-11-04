// 会话侧：把 turn/start · turn/end 变成快照，并把客户端的请求转给对应的工作区。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { keyFor, stateRoot } from './config.js'
import { detectGit } from './git.js'
import { Workspace } from './workspace.js'

export class History {
  constructor(ctx, options) {
    this.ctx = ctx
    this.options = options
    this.git = null
    this.workspaces = new Map()
    // 轮次开始时的序号与那棵树：前者给分支定位，后者是这一轮的父树。
    this.starts = new Map()
    this.preTrees = new Map()
    // 本插件自己开的分支记下切点序号；父会话关系一律读会话头。
    this.forks = Object.create(null)
  }

  async gitInfo() {
    if (this.git === null) this.git = await detectGit(this.options)
    return this.git
  }

  async workspace(root) {
    const git = await this.gitInfo()
    if (!git.ok) {
      const error = new Error(git.reason === 'too-old' ? 'git 低于 2.20' : '找不到 git')
      error.code = 'git-unavailable'
      throw error
    }
    const key = keyFor(root)
    let found = this.workspaces.get(key)
    // 先等它初始化完再判断活着没有：另一个会话可能正在建这个仓库，那时 HEAD 还没落盘。
    if (found !== undefined) {
      await found.ensure()
      // 影子仓库被删了就当新账本重来。
      if (!fs.existsSync(path.join(found.repo, 'HEAD'))) {
        this.workspaces.delete(key)
        found = undefined
      }
    }
    if (found === undefined) {
      // 目录名从 16 位哈希换成了完整哈希：旧目录还在就改名过去。
      const target = path.join(stateRoot(), key)
      const legacy = path.join(stateRoot(), key.slice(0, 16))
      if (!fs.existsSync(target) && fs.existsSync(legacy)) await fsp.rename(legacy, target).catch(() => {})
      found = new Workspace(root, git.git, this.options, (id) => this.parentOf(id))
      this.workspaces.set(key, found)
    }
    await found.ensure()
    return found
  }

  // 队列让同一个工作区的 git 调用严格串行；一次失败不会断掉队列。
  enqueue(workspace, task) {
    const next = workspace.queue.then(task)
    workspace.queue = next.catch(() => {})
    return next
  }

  // 会话在哪个工作区，官方注册表说了算：它按会话头的 cwd 建索引，侧栏分组用的也是它。
  async sessionWorkspace(sessionId) {
    const header = await this.ctx.workspaceRegistry.readSessionHeader(sessionId)
    if (!header || typeof header.cwd !== 'string' || header.cwd === '') {
      throw new Error('会话头里没有 cwd：' + String(sessionId))
    }
    return this.workspace(header.cwd)
  }

  // 会话在事件流里的位置：最后一条事件的序号与当前轮次。检查点靠它落位。
  position(sessionId) {
    const session = this.ctx.sessions.get(String(sessionId))
    let turn
    let seq
    if (session && typeof session.snapshotEvents === 'function') {
      for (const event of session.snapshotEvents()) {
        if (typeof event.seq === 'number') seq = event.seq
        if (event.type === 'turn/start' && event.data && typeof event.data.turn === 'number') turn = event.data.turn
      }
    }
    return { turn, seq }
  }

  // 从这一刻重新起一条线：把磁盘记成开头那个点，时间线和改动条才有参照。
  async reanchor(workspace, sessionId) {
    const tree = (await workspace.capture(sessionId)).tree
    if (await workspace.ensureOrigin(sessionId, tree)) await workspace.persist()
  }

  async entryOf(sessionId, turn) {
    const workspace = await this.sessionWorkspace(sessionId)
    const entry = workspace.entryAt(sessionId, turn)
    if (entry === null) throw new Error('这一轮没有快照')
    return { workspace, entry }
  }

  // 出错就照实往上报：只剩一句笼统的「没有工作区」，真正的原因就被盖住了。
  failure(error) {
    if (error && error.code === 'git-unavailable') return 'git-unavailable'
    return error && error.message ? String(error.message) : String(error)
  }

  // 父会话只认会话头；本插件刚 fork、新会话还没进会话表时用自己记的那一份兜底。
  parentOf(sessionId) {
    const current = String(sessionId)
    const session = this.ctx.sessions.get(current)
    const parent = session && session.header ? session.header.parentSession : undefined
    if (typeof parent === 'string' && parent !== '') return parent
    const fork = this.forks[current]
    return fork === undefined ? null : String(fork.parentSessionId)
  }

  familyOf(sessionId) {
    let current = String(sessionId)
    for (let depth = 0; depth < 32; depth += 1) {
      const parent = this.parentOf(current)
      if (parent === null) break
      current = parent
    }
    return current
  }

  // 这一轮还开着没有：官方没有查询接口，但事件序列本身就是答案——末条 turn/start 没有配对的 turn/end。
  turnOpen(sessionId) {
    const session = this.ctx.sessions.get(String(sessionId))
    if (!session || typeof session.snapshotEvents !== 'function') return false
    let open = 0
    for (const event of session.snapshotEvents()) {
      if (event.type === 'turn/start') open += 1
      else if (event.type === 'turn/end' && open > 0) open -= 1
    }
    return open > 0
  }

  // 会话销毁时把它留在这里的东西一并丢掉：起点树、序号、还没被叫醒的等待者。
  release(sessionId) {
    const id = String(sessionId)
    for (const key of Array.from(this.starts.keys())) if (key.startsWith(id + '#')) this.starts.delete(key)
    for (const key of Array.from(this.preTrees.keys())) if (key.startsWith(id + '#')) this.preTrees.delete(key)
    for (const workspace of this.workspaces.values()) {
      for (const key of Array.from(workspace.waiters.keys())) if (key.startsWith(id + '#')) workspace.waiters.delete(key)
      delete workspace.wrote[id]
    }
  }

  observe(session, event) {
    if (!session || !event) return
    const header = session.header
    const cwd = header ? header.cwd : undefined
    if (!cwd) return
    // 子会话的改动本来就落在主会话的快照里：整段跳过，连 turn/start 的扫描都不做。
    if (header.origin === 'subagent') return
    const sessionId = session.id
    if (event.type === 'turn/start') {
      const turn = event.data ? event.data.turn : undefined
      if (typeof turn !== 'number') return
      this.starts.set(sessionId + '#' + String(turn), event.seq)
      // 扫描排队，保证它排在上一轮的快照之后、模型这一轮的第一次编辑之前。
      // 存 promise 而不是结果：轮到 turn/end 时它可能还没扫完，那时应该等它。
      const preTree = this.workspace(cwd).then((workspace) =>
        this.enqueue(workspace, async () => (workspace.idle(sessionId) ? null : (await workspace.capture(sessionId)).tree))
      )
      this.preTrees.set(sessionId + '#' + String(turn), preTree)
      preTree.catch((error) => console.error('[file-history] ' + (error && error.message ? error.message : String(error))))
      return
    }
    if (event.type !== 'turn/end') return
    const turn = event.data ? event.data.turn : undefined
    if (typeof turn !== 'number') return
    const key = sessionId + '#' + String(turn)
    const startSeq = this.starts.get(key)
    const preTree = this.preTrees.get(key) || null
    this.starts.delete(key)
    this.preTrees.delete(key)
    this.workspace(cwd)
      .then((workspace) => {
        workspace.lastError = null
        // 分支不止一种开法：本插件的「还原对话」之外，别的插件或宿主自己 fork 出来的会话也带着
        // parentSession。只补第一次见到的分叉，本插件自己开的已经记过了。
        const parentSessionId = typeof header.parentSession === 'string' && header.parentSession !== '' ? header.parentSession : null
        const inherited = parentSessionId !== null && this.forks[String(sessionId)] === undefined ? parentSessionId : null
        if (inherited !== null) this.forks[String(sessionId)] = { parentSessionId, seq: Number.POSITIVE_INFINITY }
        const baseCommit = this.forkOf(workspace, sessionId)
        return this.enqueue(workspace, async () => {
          // 扫描失败就当作没有父树，这一轮按第一轮处理；一次卡住的扫描不该把后面每一轮都堵住。
          const tree = preTree === null ? null : await Promise.race([
            preTree.catch(() => null),
            new Promise((resolve) => {
              setTimeout(() => resolve(null), 60000).unref()
            })
          ])
          const startTree = typeof tree === 'string' && tree !== '' ? tree : null
          // 别的插件开的分支也要在时间线上留一个分支节点，否则这条线只剩轮次，看不出从哪儿分出来。
          if (inherited !== null && !workspace.idle(sessionId)) {
            const parentRows = workspace.lineTurns(inherited)
            const point = parentRows.length === 0 ? null : parentRows[parentRows.length - 1]
            if (point !== null) await workspace.addCheckpoint(sessionId, point.turn, point.tree, 'fork', point.seq)
          }
          try {
            const recorded = await workspace.snapshot({ sessionId, baseCommit, turn, startSeq, endSeq: event.seq, startTree })
            workspace.lastError = null
            return recorded
          } catch (error) {
            // 这一次没拍成要能被看见：只打 console 等于悄悄失败。
            workspace.lastError = error && error.message ? error.message : String(error)
            const waiter = workspace.waiters.get(key)
            if (waiter !== undefined) {
              workspace.waiters.delete(key)
              waiter(null)
            }
            throw error
          }
        })
      })
      .catch((error) => console.error('[file-history] ' + (error && error.message ? error.message : String(error))))
  }

  // 会话的第一轮继承它分叉点解析出的快照，不用维护一张会话表。
  forkOf(workspace, sessionId) {
    const fork = this.forks[String(sessionId)]
    if (!fork) return null
    const boundary = Math.max(0, fork.seq)
    let baseCommit = null
    for (const entry of workspace.lineTurns(fork.parentSessionId)) {
      if (entry.startSeq > boundary) break
      baseCommit = entry.commit
    }
    return baseCommit
  }

  // 子会话存在之前就先记下切点，它第一轮才能接上分支点那棵树；分支点也落成一个检查点。
  async forkBefore(workspace, entry, mode) {
    // 宿主只肯在没有开着轮次的位置切：还原对话切在这一轮开始之前，开分支切在这一轮结束之后。
    const live = this.ctx.sessions.get(entry.sessionId)
    if (!live || typeof live.snapshotEvents !== 'function') throw new Error('原会话已经不在了，没法从这里分叉。')
    let start = null
    let end = null
    for (const event of live.snapshotEvents()) {
      const turn = event.data ? event.data.turn : undefined
      if (event.type === 'turn/start' && turn === entry.turn) start = event.seq
      if (start !== null && event.type === 'turn/end' && turn === entry.turn) {
        end = event.seq
        break
      }
    }
    // 三种走法对文件与对话各是什么态度，决定新线第一轮从哪棵树上接。
    const latest = workspace.lineTurns(entry.sessionId)
    const lastTree = latest.length === 0 ? entry.tree : latest[latest.length - 1].tree
    const point = mode === 'branch' ? entry.tree : mode === 'both' ? entry.base : lastTree
    const boundary = mode === 'branch' ? (end !== null ? end : Math.max(0, entry.endSeq || 0)) : Math.max(0, (start !== null ? start : entry.startSeq || 0) - 1)
    const child = String((await this.ctx.sessions.fork(entry.sessionId, boundary)).id)
    // fork 只把 cwd 复制进新会话的头，工作区那边的成员名单得单独写一笔，否则侧栏里它不属于任何工作区。
    const here = workspace.root.toLowerCase()
    const owner = this.ctx.workspaceRegistry.list().find((item) => String(item.path).toLowerCase() === here)
    if (owner !== undefined) await owner.attachSession(child)
    this.forks[child] = { parentSessionId: entry.sessionId, seq: mode === 'chat' ? Number.POSITIVE_INFINITY : boundary }
    await this.enqueue(workspace, async () => {
      await workspace.addCheckpoint(child, entry.turn, point, 'fork', entry.endSeq)
      await workspace.persist()
    })
    return child
  }

  // 这条线自己加上各祖先在切点之前的轮次；祖先分叉之后的、兄弟分支的，都不属于它。
  // 父会话不必另存一张表——子分支最早一行的 base 就是父会话那一轮的树，按树反查就够。
  ownEntries(workspace, sessionId) {
    const own = []
    let until = null
    let at = String(sessionId)
    // 刚开出来的分支还没走过任何一轮：先看记下的分支点，再看会话头里声明的父会话。
    if (workspace.lineTurns(at).length === 0) {
      const fork = this.forks[at]
      const session = this.ctx.sessions.get(sessionId)
      const parent = session && session.header ? session.header.parentSession : undefined
      if (fork !== undefined) at = String(fork.parentSessionId)
      else if (typeof parent === 'string' && parent !== '') at = parent
    }
    for (let depth = 0; depth < 32; depth += 1) {
      const rows = workspace.lineTurns(at)
      if (rows.length === 0) break
      for (const entry of rows) if (until === null || entry.time < until) own.push(entry)
      // 根这一行没有父树可比（第一版快照的 base 就是它自己），到头了。
      if (rows[0].tree === rows[0].base) break
      const parent = this.parentOf(at)
      if (parent === null || parent === '') break
      until = rows[0].time
      at = String(parent)
    }
    own.sort((left, right) => left.time - right.time)
    return own
  }

  async handle(endpoint, payload) {
    const input = payload && typeof payload === 'object' ? payload : {}
    try {
      if (endpoint === 'wait') {
        let workspace
        try {
          workspace = await this.sessionWorkspace(input.sessionId)
        } catch (error) {
          return { ok: true, value: { entry: null, undo: false, notice: this.failure(error), baseline: null, baselines: [] } }
        }
        const entry = await workspace.wait(input.sessionId, input.turn, 15000)
        return {
          ok: true,
          value: {
            entry,
            // 这一轮扫过但没有改动时，账本里没有快照，只有这个记号。
            blank: (workspace.state.lines[String(input.sessionId)] || { blank: {} }).blank[String(input.turn)] !== undefined,
            undo: (workspace.state.lines[String(input.sessionId)] || { undo: null }).undo !== null,
            notice: null,
            baseline: await workspace.latestBaseline(input.sessionId)
          }
        }
      }
      if (endpoint === 'revert-files') {
        const found = await this.entryOf(input.sessionId, input.turn)
        const result = await this.enqueue(found.workspace, () => found.workspace.revertFiles(found.entry, undefined, input.force === true))
        // 外面改过的文件还没确认：这一趟只回报个数，一个字节都不动。
        if (result.confirm > 0) return { ok: true, value: { confirm: result.confirm } }
        return { ok: true, value: { written: result.written, removed: result.removed } }
      }
      if (endpoint === 'revert-chat') {
        const found = await this.entryOf(input.sessionId, input.turn)
        const child = await this.forkBefore(found.workspace, found.entry, 'chat')
        return { ok: true, value: { childSessionId: child } }
      }
      if (endpoint === 'branch') {
        const found = await this.entryOf(input.sessionId, input.turn)
        const result = await this.enqueue(found.workspace, () => found.workspace.revertFiles(found.entry, found.entry.tree, input.force === true))
        // 开分支也把磁盘拉到那一版，代价和还原一样，所以同样先问。
        if (result.confirm > 0) return { ok: true, value: { confirm: result.confirm } }
        const child = await this.forkBefore(found.workspace, found.entry, 'branch')
        return { ok: true, value: { written: result.written, removed: result.removed, childSessionId: child } }
      }
      if (endpoint === 'revert-both') {
        const found = await this.entryOf(input.sessionId, input.turn)
        const result = await this.enqueue(found.workspace, () => found.workspace.revertFiles(found.entry, undefined, input.force === true))
        if (result.confirm > 0) return { ok: true, value: { confirm: result.confirm } }
        const child = await this.forkBefore(found.workspace, found.entry, 'both')
        return { ok: true, value: { written: result.written, removed: result.removed, childSessionId: child } }
      }
      if (endpoint === 'drop-point') {
        const workspace = await this.sessionWorkspace(input.sessionId)
        if (typeof input.tree !== 'string' || input.tree === '') {
          return { ok: false, error: { code: 'no-tree', message: '没有要删除的检查点', details: {} } }
        }
        const result = await this.enqueue(workspace, () => workspace.dropPoint(input.tree))
        return { ok: true, value: { removed: result.removed } }
      }
      if (endpoint === 'undo-revert') {
        const workspace = await this.sessionWorkspace(input.sessionId)
        const result = await this.enqueue(workspace, () => workspace.undoRevert(input.sessionId))
        return { ok: true, value: { written: result.written, removed: result.removed } }
      }
      if (endpoint === 'baseline') {
        let workspace
        try {
          workspace = await this.sessionWorkspace(input.sessionId)
        } catch (error) {
          return { ok: true, value: { baseline: null, changes: [], stats: null, notice: this.failure(error) } }
        }
        if (input.action === 'set') {
          // 一轮还没写完就设点，会把半轮的磁盘状态当成一版留下来：等这一轮结束再点。
          if (this.turnOpen(input.sessionId)) {
            return { ok: false, error: { code: 'turn-running', message: '这一轮还没结束，等它写完再设检查点。', details: {} } }
          }
          // 底栏发起的手动点不带轮次：位置由宿主补齐，这样它和另外两种检查点一样能对上会话。
          const at = this.position(input.sessionId)
          const turn = typeof input.turn === 'number' ? input.turn : at.turn
          const seq = typeof input.seq === 'number' ? input.seq : at.seq
          // 只有「当前这一轮」能现拍：历史轮次没有那棵树，补不了检查点。
          const current = typeof at.turn !== 'number' || turn === at.turn
          return { ok: true, value: await this.enqueue(workspace, () => workspace.setBaseline(input.sessionId, turn, input.tree, seq, current)) }
        }
        if (input.action === 'revert') {
          const reverted = await this.enqueue(workspace, () => workspace.revertBaseline(input.sessionId, input.tree, input.force === true))
          if (reverted.confirm > 0) return { ok: true, value: { confirm: reverted.confirm } }
          return { ok: true, value: { written: reverted.written, removed: reverted.removed } }
        }
        return { ok: true, value: await this.enqueue(workspace, () => workspace.baseline(input.sessionId)) }
      }
      if (endpoint === 'clear') {
        const workspace = await this.sessionWorkspace(input.sessionId)
        const scope = input.scope === 'all' ? 'all' : 'turns'
        // 一家就是一棵树：一条会话属于这家，当且仅当它的根就是这棵树的根。
        const familyRoot = this.familyOf(input.sessionId)
        const isMine = (id) => this.familyOf(id) === familyRoot
        // 清完这一家就空了：这条会话还开着就把此刻的磁盘重新记成开头那个点；关掉的什么都不做。
        const cleared = await this.enqueue(workspace, async () => {
          const result = await workspace.dropHistory(scope, isMine)
          if (!workspace.idle(input.sessionId)) await this.reanchor(workspace, input.sessionId)
          return result
        })
        return { ok: true, value: cleared }
      }
      if (endpoint === 'entries') {
        let workspace
        try {
          workspace = await this.sessionWorkspace(input.sessionId)
        } catch (error) {
          return { ok: true, value: { entries: [], undo: false, notice: this.failure(error) } }
        }
        // ownEntries 拿到的是已经补齐过的记录（会话、轮次、统计），新的在前，直接发出去。
        const own = this.ownEntries(workspace, input.sessionId)
        const rows = own.slice().reverse()
        // 检查点跟着列表一起发回去：时间线要把「轮次」和「检查点」按时间合在一起排。
        const familyRoot = this.familyOf(input.sessionId)
        const baselines = workspace.pointsOf(input.sessionId)
        // 工作区只有一份文件。同族的另一条分支若在本线之后动过，磁盘上放的就是他们那一版，
        // 本线的差异条也就没啥可看的了。
        const lastTouch = workspace.lastTouch()
        let mine = null
        for (const entry of own) if (entry.sessionId === input.sessionId && (mine === null || entry.time > mine.time)) mine = entry
        const elsewhere =
          lastTouch === null ||
          String(lastTouch.sessionId) === String(input.sessionId) ||
          this.familyOf(lastTouch.sessionId) !== familyRoot ||
          (mine !== null && lastTouch.time <= mine.time)
            ? null
            : { sessionId: lastTouch.sessionId, time: lastTouch.time }
        // 树层的设置：同一棵树里的会话读到同一份；一次都没扫过的树先按插件配置显示。
        const conf = workspace.treeCfg(input.sessionId)
        const line = workspace.state.lines[String(input.sessionId)]
        // 扫过但没有改动的轮次：客户端靠它区分「没变」与「没扫」（自动快照关着）。
        const blank = line === undefined || line.blank === undefined ? [] : Object.keys(line.blank).map(Number)
        const usage = await workspace.usage(input.sessionId)
        return {
          ok: true,
          value: {
            off: workspace.idle(input.sessionId),
            auto: conf.auto !== false,
            keep: conf.keep,
            excludes: conf.excludes,
            allow: conf.allow || [],
            usage,
            entries: rows,
            blank,
            undo: line !== undefined && line.undo !== null && line.undo !== undefined,
            notice: workspace.lastError,
            baseline: baselines[0] || null,
            baselines,
            elsewhere
          }
        }
      }
      if (endpoint === 'config') {
        const workspace = await this.sessionWorkspace(input.sessionId)
        return {
          ok: true,
          value: await this.enqueue(workspace, async () => {
            const conf = workspace.treeCfg(input.sessionId)
            // 开关与规则管的是整棵会话树：写在树根上，同一棵树里的每一条会话读到同一个结果。
            if (typeof input.off === 'boolean') workspace.setTreeOff(input.sessionId, input.off)
            if (typeof input.auto === 'boolean') conf.auto = input.auto
            if (typeof input.keep === 'number' && Number.isFinite(input.keep)) {
              conf.keep = Math.max(0, Math.min(1000, Math.round(input.keep)))
            }
            // 一行一条，逗号也当分隔符；空行去掉，重复的只留一份。
            const rules = (text, strip) =>
              Array.from(new Set(text.split(/[\r\n,]+/).map((one) => (strip ? one.trim().replace(/^\.\//, '').replace(/^\/+/, '') : one.trim())).filter((one) => one !== '')))
            if (typeof input.rules === 'string') conf.excludes = rules(input.rules, false)
            // 白名单同一套写法：不管写成 /src 还是 ./src，一律按不带前导斜杠的相对路径比。
            if (typeof input.allow === 'string') conf.allow = rules(input.allow, true)
            // 上一轮留下的那棵树是按旧规则扫的，拿它比差就还是旧结果：作废，让改动条重扫一遍。
            workspace.freshTree = null
            await workspace.persist()
            // 打开它就是重新开始记：这一家还没有点的话，把此刻的磁盘记成开头那个点。
            if (input.off === false && !workspace.idle(input.sessionId)) await this.reanchor(workspace, input.sessionId)
            return { off: conf.off === true, auto: conf.auto !== false, keep: conf.keep, excludes: conf.excludes, allow: conf.allow || [] }
          })
        }
      }
      return { ok: false, error: { code: 'unknown-endpoint', message: 'unknown endpoint ' + String(endpoint), details: {} } }
    } catch (error) {
      return { ok: false, error: { code: 'file-history', message: error && error.message ? error.message : String(error), details: {} } }
    }
  }
}
