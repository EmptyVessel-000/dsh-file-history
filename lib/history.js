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

  // 一处取数：这条会话的工作区 + 这一轮（或这个点拼出来的）记录。取不到就说清为什么。
  async entryOf(sessionId, turn) {
    const workspace = await this.sessionWorkspace(sessionId)
    const entry = workspace.entryAt(sessionId, turn)
    if (entry === null) throw new Error('这一轮没有快照：它可能已经被裁剪掉了。')
    return { workspace, entry }
  }

  // 从这一刻重新起一条线：把磁盘记成开头那个点，时间线和改动条才有参照。
  async reanchor(workspace, sessionId) {
    const tree = (await workspace.capture(sessionId)).tree
    if (await workspace.ensureOrigin(sessionId, tree)) await workspace.persist()
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

  // 会话的第一轮继承它分叉点解析出的快照。切点从会话头里算：宿主 fork 时把继承前缀的
  // 事件条数写进 inheritedEventCount，数一下前缀里最后一个 turn/end 就知道切在第几轮。
  // 不靠内存里的分支表，所以重启之后照样接得上。
  forkOf(workspace, sessionId) {
    const live = this.ctx.sessions.get(sessionId)
    if (!live || typeof live.snapshotEvents !== 'function') return null
    const inherited = Number(live.inheritedEventCount || 0)
    if (inherited <= 0) return null
    const parentSessionId = live.header ? live.header.parentSession : undefined
    if (typeof parentSessionId !== 'string' || parentSessionId === '') return null
    let boundary = null
    for (const event of live.snapshotEvents()) {
      if (event.seq >= inherited) break
      if (event.type === 'turn/end') boundary = event.seq
    }
    if (boundary === null) return null
    let baseCommit = null
    for (const entry of workspace.lineTurns(parentSessionId)) {
      if (entry.startSeq > boundary) break
      baseCommit = entry.commit
    }
    return baseCommit
  }

  // 子会话存在之前就先记下切点，它第一轮才能接上分支点那棵树；分支点也落成一个检查点。
  async forkBefore(workspace, entry, options) {
    const live = this.ctx.sessions.get(entry.sessionId)
    if (!live || typeof live.snapshotEvents !== 'function') throw new Error('原会话已经不在了，没法从这里分叉。')
    let end = null
    for (const event of live.snapshotEvents()) {
      const turn = event.data ? event.data.turn : undefined
      if (event.type === 'turn/end' && turn === entry.turn) {
        end = event.seq
        break
      }
    }
    // 「到此处」这一轮算在内：切点一律落在这轮结束之后，新会话里有这一轮。
    const boundary = end !== null ? end : Math.max(0, entry.endSeq || 0)
    // 新线起步的文件版本跟着「盘动没动」走：动了就是这一轮结束时的样子，
    // 没动就取磁盘现在这一版。
    const point = options.move === true ? entry.tree : (await workspace.capture(entry.sessionId)).tree
    const child = String((await this.ctx.sessions.fork(entry.sessionId, boundary)).id)
    // fork 只把 cwd 复制进新会话的头，工作区那边的成员名单得单独写一笔，否则侧栏里它不属于任何工作区。
    const here = workspace.root.toLowerCase()
    const owner = this.ctx.workspaceRegistry.list().find((item) => String(item.path).toLowerCase() === here)
    if (owner !== undefined) await owner.attachSession(child)
    this.forks[child] = { parentSessionId: entry.sessionId, seq: boundary }
    // 「还原文件和会话」等于把这条会话收起来：新线接上去，旧的归档，侧栏里只剩回来的这一条。
    // 会话正忙时宿主会拒绝归档（WorkspaceActiveSessionError），那就照常留着，别让整个还原失败。
    let archived = true
    if (options.archive === true) {
      try {
        await this.ctx.workspaceRegistry.archiveSession(entry.sessionId)
      } catch (error) {
        archived = false
      }
    }
    await this.enqueue(workspace, async () => {
      await workspace.addCheckpoint(child, entry.turn, point, 'fork', entry.endSeq)
      await workspace.persist()
    })
    return { child, archived }
  }

  // 这条线自己加上各祖先在切点之前的轮次；祖先分叉之后的、兄弟分支的，都不属于它。
  // 祖先靠会话头里的 parentSession 串起来，插件不另存家族表。
  ownEntries(workspace, sessionId) {
    const own = []
    let until = null
    let at = String(sessionId)
    // 刚开出来的分支还没走过任何一轮：退到它的父会话，和 parentOf 一个口径。
    if (workspace.lineTurns(at).length === 0) {
      const parent = this.parentOf(at)
      if (parent !== null) at = String(parent)
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
      // 读一切：时间线、检查点、这棵树的设置、占用，以及（按需）当前磁盘与最新检查点的差异。
      if (endpoint === 'state') {
        let workspace
        try {
          workspace = await this.sessionWorkspace(input.sessionId)
        } catch (error) {
          // entries 给 null 而不是空数组：客户端据此沿用上一份列表，只把失败原因摆出来。
          // 给空数组等于告诉它「这条会话没有历史」，一次抖动就把整条时间线抹了。
          return { ok: true, value: { entries: null, baselines: [], baseline: null, notice: this.failure(error) } }
        }
        // 带轮次时先等这一轮落账：客户端拿到回话后再读，就不可能还是旧账。超时也照常返回当前状态。
        if (typeof input.turn === 'number') await workspace.wait(input.sessionId, input.turn, 15000)
        // ownEntries 拿到的是已经补齐过的记录（会话、轮次、统计），新的在前，直接发出去。
        const own = this.ownEntries(workspace, input.sessionId)
        const rows = own.slice().reverse()
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
        // 差异要真扫一次盘，只有底栏需要，所以按需算——别让每张卡片都拖着一次全树扫描。
        // 扫失败只影响这一格：时间线不该因为一次扫盘出错就整片消失。
        let diff = null
        if (input.diff === true) {
          try {
            diff = await this.enqueue(workspace, () => workspace.baseline(input.sessionId))
          } catch (error) {
            diff = { baseline: null, changes: [], stats: null, notice: this.failure(error) }
          }
        }
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
            notice: workspace.lastError,
            baseline: baselines[0] || null,
            baselines,
            elsewhere,
            diff
          }
        }
      }
      // 检查点只有三个动作：设一个、还原到某个、删掉某个。
      if (endpoint === 'point') {
        const workspace = await this.sessionWorkspace(input.sessionId)
        const action = input.action
        if (action === 'delete') {
          if (typeof input.tree !== 'string' || input.tree === '') {
            return { ok: false, error: { code: 'no-tree', message: '没有要删除的检查点', details: {} } }
          }
          const result = await this.enqueue(workspace, () => workspace.dropPoint(input.tree))
          return { ok: true, value: { removed: result.removed } }
        }
        if (action === 'revert') {
          // 不给 tree 就是还原到「最新那个检查点」，和底栏上写的时间点一致。
          const wanted = typeof input.tree === 'string' && input.tree !== '' ? input.tree : (await this.enqueue(workspace, () => workspace.baseline(input.sessionId))).baseline
          const reverted = await this.enqueue(workspace, () => workspace.revertBaseline(input.sessionId, wanted === null || wanted === undefined ? undefined : wanted.tree, input.force === true))
          if (reverted.confirm > 0) return { ok: true, value: { confirm: reverted.confirm } }
          return { ok: true, value: { written: reverted.written, removed: reverted.removed } }
        }
        // 设点：一轮还没写完就点，会把半轮的磁盘状态当成一版留下来，等它结束再点。
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

      // 还原、分支、撤销同属一件事：把工作区（和会话）送回某一轮，只是「动什么」不同。
      if (endpoint === 'restore') {
        const workspace = await this.sessionWorkspace(input.sessionId)
        const mode = input.mode
        const turn = typeof input.turn === 'number' ? input.turn : undefined
        const tree = typeof input.tree === 'string' && input.tree !== '' ? input.tree : undefined
        const force = input.force === true
        // 撤销不看轮次表现在记在哪：它要的是「这一轮开始前」那一版，记录里带着。
        if (mode === 'undo') {
          const reverted = await this.enqueue(workspace, () => workspace.undoRevert(input.sessionId, tree, turn, force))
          if (reverted.confirm > 0) return { ok: true, value: { confirm: reverted.confirm } }
          return { ok: true, value: { written: reverted.written, removed: reverted.removed } }
        }
        const entry = workspace.entryAt(input.sessionId, turn)
        if (entry === null) throw new Error('这一轮没有快照：它可能已经被裁剪掉了。')
        // 只还原对话：盘不动，新线接着这一轮往下走。
        if (mode === 'chat') {
          const forked = await this.forkBefore(workspace, entry, { move: true, archive: false })
          return { ok: true, value: { written: 0, removed: 0, childSessionId: forked.child, archived: forked.archived } }
        }
        const reverted = await this.enqueue(workspace, () => workspace.revertTree(entry.sessionId, entry.tree, force, entry.turn))
        if (reverted.confirm > 0) return { ok: true, value: { confirm: reverted.confirm } }
        if (mode === 'files') return { ok: true, value: { written: reverted.written, removed: reverted.removed } }
        const forked = await this.forkBefore(workspace, entry, { move: true, archive: mode === 'both' })
        return { ok: true, value: { written: reverted.written, removed: reverted.removed, childSessionId: forked.child, archived: forked.archived } }
      }

      // 清除只管这一家：别的分支各有各的记录，别一并抹掉。
      if (endpoint === 'clear') {
        const workspace = await this.sessionWorkspace(input.sessionId)
        const familyRoot = this.familyOf(input.sessionId)
        const isMine = (id) => this.familyOf(id) === familyRoot
        const scope = input.scope === 'all' ? 'all' : 'turns'
        const result = await this.enqueue(workspace, () => workspace.dropHistory(scope, isMine))
        // 清完还开着就重新起一条线：没有参照，时间线和改动条都不知道该跟谁比。
        if (!workspace.idle(input.sessionId)) await this.enqueue(workspace, () => this.reanchor(workspace, input.sessionId))
        return { ok: true, value: result }
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
