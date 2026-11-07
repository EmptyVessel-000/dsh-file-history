// 一个工作区的账本与影子仓库：拍快照、记检查点、还原、裁剪、清空。
// 三种 sha 从不混用：commit 是历史里的一个点，tree 是一次快照的文件清单，blob 是一个文件的内容。
// 账本按层存：全局配置在插件配置里，树层放配置，会话层放数据（轮次、检查点、撤销点）。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DEFAULTS, LEDGER_VERSION, keyFor, stateRoot } from './config.js'
import { run } from './git.js'
import { foldPointers, parseBatchBlobs, parseLsFiles, parseNumstat, parseRaw, parseSizes, summarize } from './parse.js'

export class Workspace {
  constructor(root, git, options, parentOf) {
    this.root = path.resolve(root)
    this.git = git
    this.options = options
    // 会话的父级只有 History 知道：找树根靠它。
    this.parentOf = parentOf || (() => null)
    this.key = keyFor(this.root)
    this.dir = path.join(stateRoot(), this.key)
    this.repo = path.join(this.dir, 'repo.git')
    this.indexFile = path.join(this.dir, 'index')
    this.ledgerFile = path.join(this.dir, 'index.json')
    this.ready = null
    this.queue = Promise.resolve()
    this.state = null
    // 上一次我们自己写进磁盘的那一版：和它对上就说明外面没人动过，还原前不必多问一句。
    this.wrote = Object.create(null)
    this.lastError = null
    // 正在等快照的客户端：键是 sessionId#turn，值是唤醒函数。
    this.waiters = new Map()
    // 轮次结束刚扫出的树：改动条紧接着来读差异时直接用它，不必为同一瞬间再扫一遍。
    this.freshTree = null
    // 占用上一次算出来的结果：账本一改就作废，不必为每次刷新都起一个 git 进程。
    this.usageCache = null
  }

  async g(args, options) {
    const opts = options || {}
    const argv = ['--git-dir=' + this.repo, '--work-tree=' + this.root].concat(args)
    const result = await run(this.git, argv, { cwd: this.root, env: opts.env, input: opts.input })
    if (opts.allowFail) return result
    if (result.code !== 0) {
      throw new Error(
        result.stderr.toString('utf8').trim() || result.stdout.toString('utf8').trim() || 'git ' + String(args[0]) + ' failed'
      )
    }
    return result
  }

  // 初始化只做一次；失败就把这张票作废，下一次重试探，免得一次 git 出错永久卡住这个工作区。
  ensure() {
    if (this.ready === null) {
      this.ready = this.setup().catch((error) => {
        this.ready = null
        throw error
      })
    }
    return this.ready
  }

  async setup() {
    await fsp.mkdir(this.dir, { recursive: true })
    if (!fs.existsSync(path.join(this.repo, 'HEAD'))) {
      // 仓库不在了说明被删过：账本里那些行指着的提交已经不存在，留着只会让每轮比对都出错。
      await fsp.rm(this.ledgerFile, { force: true })
      // 上一次 init 被打断会留下半个目录（description 这类模板文件已经在），git init 再进去会报
      // "cannot copy ... description: File exists" 并一直失败：没有 HEAD 就整个清掉重来。
      await fsp.rm(this.repo, { recursive: true, force: true })
      const init = await run(this.git, ['init', '--bare', '--quiet', this.repo], {})
      if (init.code !== 0) throw new Error(init.stderr.toString('utf8').trim() || 'git init failed')
      await fsp.rm(this.indexFile, { force: true })
    }
    // 老版本在 repo 里留下过自己的 index：它的 cache-tree 指着早就回收掉的树，gc 走到这里会中途失败。
    await fsp.rm(path.join(this.repo, 'index'), { force: true })
    await fsp.mkdir(path.join(this.repo, 'info'), { recursive: true })
    for (const pair of [
      ['core.bare', 'true'],
      ['core.autocrlf', 'false'],
      ['core.fileMode', 'false'],
      ['core.ignoreCase', 'true'],
      ['advice.addEmbeddedRepo', 'false'],
      ['gc.auto', '0']
    ]) {
      await this.g(['config', pair[0], pair[1]], { allowFail: true })
    }
    this.state = await this.loadLedger()
    return this
  }

  async loadLedger() {
    let parsed = null
    try {
      parsed = JSON.parse(await fsp.readFile(this.ledgerFile, 'utf8'))
    } catch {
      parsed = null
    }
    if (parsed === null || typeof parsed !== 'object') return { version: LEDGER_VERSION, big: [], trees: {}, lines: {} }
    // 旧版本的账本不要了：版本号一变就从空账本重来，不再写迁移代码。
    if (parsed.version !== LEDGER_VERSION) return { version: LEDGER_VERSION, big: [], trees: {}, lines: {} }
    return this.normalize(parsed)
  }

  // 读到什么形状都先摆正：缺的字段补上，类型不对的按默认值纠正，坏行直接丢掉。
  normalize(parsed) {
    parsed.big = Array.isArray(parsed.big) ? parsed.big : []
    parsed.trees = parsed.trees && typeof parsed.trees === 'object' ? parsed.trees : {}
    parsed.lines = parsed.lines && typeof parsed.lines === 'object' ? parsed.lines : {}
    for (const [id, line] of Object.entries(parsed.lines)) {
      if (!line || typeof line !== 'object') {
        delete parsed.lines[id]
        continue
      }
      if (!line.turn || typeof line.turn !== 'object') line.turn = {}
      if (!line.point || typeof line.point !== 'object') line.point = {}
      for (const [tree, point] of Object.entries(line.point)) {
        if (!point || typeof point !== 'object' || typeof point.turn !== 'number') {
          delete line.point[tree]
          continue
        }
        if (typeof point.time !== 'number') point.time = 0
        if (typeof point.seq !== 'number') point.seq = 0
        if (point.source !== 'origin' && point.source !== 'fork') point.source = 'manual'
        // 只有手动点带着一份快照拷贝：它接替被删掉的那条轮次记录。
        if (point.entry === undefined || point.entry === null || typeof point.entry !== 'object') delete point.entry
        else if (!Array.isArray(point.entry.changes)) point.entry.changes = []
      }
      // 「扫过但没有改动」的轮次：只记轮次与时间，不存树也不存差异。
      if (!line.blank || typeof line.blank !== 'object') line.blank = {}
      }
    return parsed
  }

  async persist() {
    this.usageCache = null
    const tmp = this.ledgerFile + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(this.state))
    await fsp.rename(tmp, this.ledgerFile)
  }

  // 一条会话的树根：顺着父链一直往上，到没有父会话为止。分叉出来的会话共用这一个根。
  rootOf(sessionId) {
    let at = String(sessionId)
    for (let depth = 0; depth < 64; depth += 1) {
      const parent = this.parentOf(at)
      if (parent === null || parent === undefined || parent === '' || String(parent) === at) return at
      at = String(parent)
    }
    return at
  }

  keepTurns() {
    const value = this.options.keepRecentTurns
    return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULTS.keepRecentTurns
  }

  // 裁到倒数第几个检查点：树层有自己的值，插件配置只作新树的默认值。
  prunePoints() {
    const value = this.options.pruneAfterCheckpoints
    return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : DEFAULTS.pruneAfterCheckpoints
  }

  freshTreeCfg() {
    return { off: false, auto: true, keep: this.keepTurns(), prune: this.prunePoints(), excludes: this.options.excludes.slice(), allow: [] }
  }

  // 树层的配置：关掉、自动拍、保留轮次、排除与允许规则。没有就按插件配置造一份。
  treeCfg(sessionId) {
    const root = this.rootOf(sessionId)
    const trees = this.state.trees
    const own = trees[root]
    if (own !== undefined && own !== null && typeof own === 'object') {
      // 空对象、字符串、NaN 都按默认值纠正回来：配置这一层只能放这四个值。
      if (typeof own.off !== 'boolean') own.off = false
      if (typeof own.auto !== 'boolean') own.auto = true
      if (typeof own.keep !== 'number' || Number.isFinite(own.keep) === false) own.keep = this.keepTurns()
      if (typeof own.prune !== 'number' || Number.isFinite(own.prune) === false) own.prune = this.prunePoints()
      if (!Array.isArray(own.excludes)) own.excludes = this.options.excludes.slice()
      if (!Array.isArray(own.allow)) own.allow = []
      trees[root] = own
      return own
    }
    const fresh = this.freshTreeCfg()
    trees[root] = fresh
    return fresh
  }

  // 会话层：这条线的全部数据都在这里，轮次直接以轮次号作键。
  lineOf(sessionId) {
    const key = String(sessionId)
    const own = this.state.lines[key]
    if (own !== undefined && own !== null && typeof own === 'object') return own
    const fresh = { turn: {}, point: {}, blank: {} }
    this.state.lines[key] = fresh
    return fresh
  }

  // 一条线记下的轮次，按轮次号升序（数字键天然有序，这里只是摆成数组方便遍历）。
  lineTurns(sessionId) {
    const line = this.state.lines[String(sessionId)]
    if (line === undefined || line === null) return []
    return Object.keys(line.turn)
      .map(Number)
      .sort((left, right) => left - right)
      .map((turn) => this.hydrate(sessionId, turn, line.turn[String(turn)]))
  }

  // 关掉的是整棵树，不是一条会话；已经存下的时间线照旧能看能还原。
  idle(sessionId) {
    return this.treeCfg(sessionId).off === true
  }

  setTreeOff(sessionId, off) {
    this.treeCfg(sessionId).off = off === true
  }

  // 这一棵树的检查点：各条会话自己建的点合在一起，时间倒序。
  pointsOf(sessionId) {
    const root = this.rootOf(sessionId)
    const rows = []
    for (const [id, line] of Object.entries(this.state.lines)) {
      if (this.rootOf(id) !== root) continue
      for (const [tree, point] of Object.entries(line.point)) rows.push(Object.assign({ tree, sessionId: id }, point))
    }
    rows.sort((left, right) => right.time - left.time)
    return rows
  }

  // 整个工作区最后动过文件的那一轮：同族的另一条分支若在本线之后动过，磁盘上放的就是他们那一版。
  lastTouch() {
    let newest = null
    for (const [id, line] of Object.entries(this.state.lines)) {
      for (const [turn, entry] of Object.entries(line.turn)) {
        if (newest !== null && entry.time <= newest.time) continue
        newest = this.hydrate(id, turn, entry)
      }
    }
    return newest
  }

  countEntries() {
    let total = 0
    for (const line of Object.values(this.state.lines)) total += Object.keys(line.turn).length
    return total
  }

  // 占用按树算：只数这棵树自己的提交与检查点能走到的对象，不报工作区合计——
  // 那个数会把别的树也带进来，跟这里的层次对不上。
  async usage(sessionId) {
    const root = this.rootOf(sessionId)
    if (this.usageCache !== null && this.usageCache.root === root) return this.usageCache
    const refs = []
    for (const [id, line] of Object.entries(this.state.lines)) {
      if (this.rootOf(id) !== root) continue
      // 线的头只在引用里：这条线还有东西可数，就把它的引用一起交给 rev-list。
      if (Object.keys(line.turn).length > 0 || Object.keys(line.point).length > 0) refs.push('refs/lines/' + id)
      for (const tree of Object.keys(line.point)) refs.push('refs/checkpoints/' + tree)
    }
    let objects = 0
    if (refs.length > 0) {
      // 一条命令给出这批对象占的字节数：一次遍历，不按对象起进程。
      const counted = await this.g(['rev-list', '--disk-usage', '--objects'].concat(refs), { allowFail: true })
      const value = Number(counted.stdout.toString('utf8').trim())
      if (counted.code === 0 && Number.isFinite(value)) objects = value
    }
    this.usageCache = { root, objects, total: objects }
    return this.usageCache
  }

  // 记录什么、比什么，都由同一份路径范围说了算：白名单收窄成那几条，排除规则推开。
  // 范围交给 git 的 pathspec，不为它另写一套匹配规则。
  spec(conf) {
    if (conf === null) return []
    return (conf.allow || []).concat((conf.excludes || []).map((rule) => ':(exclude)' + rule))
  }

  // 还超着大小限制的文件继续按 pathspec 排除，不会被重新哈希；变小之后自己就回来了。
  async bigStillBig() {
    const kept = []
    for (const relative of this.state.big) {
      try {
        const stat = await fsp.stat(path.join(this.root, ...relative.split('/')))
        if (stat.size > this.options.maxFileBytes) kept.push(relative)
      } catch {
        // 已经不在了。
      }
    }
    return kept
  }

  // 索引里现在有什么：两个地方都要按同一个姿势读，路径参数只是收窄。
  async listIndex(env, ...range) {
    return parseLsFiles((await this.g(['ls-files', '-s', '-z'].concat(range), { env })).stdout)
  }

  // 把一批路径从索引里摘掉：排除规则命中、白名单外、太大不记，走的是同一条命令。
  async dropPaths(env, paths) {
    if (paths.length === 0) return
    await this.g(['update-index', '--force-remove', '-z', '--stdin'], {
      env,
      input: Buffer.from(paths.map((one) => one + '\u0000').join(''), 'utf8')
    })
  }

  async capture(sessionId) {
    await this.ensure()
    const env = { GIT_INDEX_FILE: this.indexFile }
    const conf = sessionId === undefined || sessionId === null ? null : this.treeCfg(sessionId)
    const spec = this.spec(conf)
    const big = await this.bigStillBig()
    const excludes = []
    let budget = 6000
    for (const relative of big) {
      budget -= relative.length + 16
      if (budget < 0) break
      excludes.push(':(exclude,literal)' + relative)
    }
    // 索引里可能留着被 gc 剪掉的旧对象。没变的文件 add 不会重写对象，紧接着 write-tree 就报
    // "invalid object"。清掉索引整个重来一次，让它重新哈希。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        let rows = null
        const repos = []
        for (let round = 0; round < 3; round += 1) {
          await this.g(['add', '-A', '--'].concat(spec.length > 0 ? spec : ['.'], excludes), { env })
          rows = await this.listIndex(env)
          // 判定为太大、决定不展开的仓库不再进这一轮，否则指针一直挂着，循环白跑三轮。
          const pointers = rows.filter((row) => row.mode === '160000' && repos.indexOf(row.path) < 0)
          if (pointers.length === 0) break
          for (const at of await this.embed(env, pointers)) repos.push(at)
          rows = null
        }
        if (rows === null) rows = await this.listIndex(env)
        const skipped = await this.dropBig(env, big, rows)
        // 索引里还留着上一轮的东西：白名单刚收紧、某个路径刚被排除，它们不会自己消失。
        if (spec.length > 0) {
          const keep = new Set((await this.listIndex(env, '--', ...spec)).map((row) => row.path))
          await this.dropPaths(env, rows.filter((row) => !keep.has(row.path)).map((row) => row.path))
        }
        const tree = await this.g(['write-tree'], { env })
        return { tree: tree.stdout.toString('utf8').trim(), skipped, repos }
      } catch (error) {
        if (attempt === 1) throw error
        await fsp.rm(this.indexFile, { force: true })
      }
    }
  }

  async dropBig(env, known, rows) {
    if (rows.length === 0) {
      this.state.big = known
      return { count: 0, bytes: 0, capped: 0 }
    }
    const checked = await this.g(['cat-file', '--batch-check'], {
      env,
      input: Buffer.from(rows.map((row) => row.sha + '\n').join(''), 'utf8')
    })
    const sizes = parseSizes(checked.stdout)
    const big = rows.filter((row) => (sizes.get(row.sha) || 0) > this.options.maxFileBytes)
    // 目录与总量的降级不写进 state.big：它取决于这一轮有多少文件，记死之后那个目录就再也进不来。
    const capped = new Set()
    // 一遍把目录和它的文件归到一起：以前是按目录回扫全表，目录一多就是行数乘目录数。
    const byDir = new Map()
    let total = 0
    for (const row of rows) {
      total += sizes.get(row.sha) || 0
      const cut = row.path.lastIndexOf('/')
      const at = cut < 0 ? '.' : row.path.slice(0, cut)
      const bucket = byDir.get(at)
      if (bucket === undefined) byDir.set(at, [row])
      else bucket.push(row)
    }
    for (const bucket of byDir.values()) {
      if (bucket.length <= this.options.maxDirFiles) continue
      for (const row of bucket) capped.add(row.path)
    }
    // 总量超预算时从最大的让起：留着几个几百 MB 的产物，比留着半棵树更有用。
    if (total > this.options.maxBytes) {
      const order = rows.slice().sort((left, right) => (sizes.get(right.sha) || 0) - (sizes.get(left.sha) || 0))
      for (const row of order) {
        if (total <= this.options.maxBytes) break
        if (capped.has(row.path)) continue
        capped.add(row.path)
        total -= sizes.get(row.sha) || 0
      }
    }
    const merged = known.slice()
    let bytes = 0
    for (const row of big) {
      bytes += sizes.get(row.sha) || 0
      if (merged.indexOf(row.path) < 0) merged.push(row.path)
    }
    merged.sort()
    this.state.big = merged
    const drop = new Set(big.map((row) => row.path))
    for (const relative of capped) drop.add(relative)
    if (drop.size === 0) return { count: 0, bytes, capped: 0 }
    await this.dropPaths(env, Array.from(drop))
    return { count: drop.size, bytes, capped: capped.size }
  }

  // 把子模块指针换成它里面的文件：指针本身没有内容，留着它既看不到改动，还原时也无从下手。
  async embed(env, pointers) {
    const entries = []
    const skipped = []
    for (const pointer of pointers) {
      const listed = await run(this.git, ['-C', path.join(this.root, ...pointer.path.split('/')), 'ls-files', '-z', '-c', '-o', '--exclude-standard'], { timeoutMs: 60000 })
      if (listed.code !== 0) continue
      const names = listed.stdout.toString('utf8').split('\u0000').filter((part) => part !== '')
      if (names.length > this.options.maxRepoFiles) {
        skipped.push(pointer.path)
        continue
      }
      entries.push('0 ' + '0'.repeat(40) + '\t' + pointer.path)
      const wanted = []
      for (const part of names) {
        const at = pointer.path + '/' + part
        let stat = null
        try {
          stat = await fsp.lstat(path.join(this.root, ...at.split('/')))
        } catch {
          continue
        }
        // 底下要是还套着一层仓库，它只肯给出目录名；那一层留给下一轮。
        if (stat.isFile() === false) continue
        wanted.push({ at, mode: (stat.mode & 0o111) !== 0 ? '100755' : '100644' })
      }
      if (wanted.length === 0) continue
      const hashed = await run(this.git, ['--git-dir=' + this.repo, 'hash-object', '-w', '--stdin-paths'], { cwd: this.root, input: wanted.map((file) => file.at).join('\n') + '\n', timeoutMs: 120000 })
      const shas = hashed.code === 0 ? hashed.stdout.toString('utf8').split('\n').filter((line) => line !== '') : []
      // 少一个就对不上号，宁可这一轮先不补，也不能把错的 sha 写进索引。
      if (shas.length !== wanted.length) continue
      for (let i = 0; i < wanted.length; i += 1) entries.push(wanted[i].mode + ' ' + shas[i] + '\t' + wanted[i].at)
    }
    if (entries.length > 0) {
      await this.g(['update-index', '-z', '--index-info'], { env, input: Buffer.from(entries.join('\u0000') + '\u0000', 'utf8') })
    }
    return skipped
  }

  async diffTrees(fromTree, toTree, pathspec) {
    const filter = []
    if (Array.isArray(pathspec) && pathspec.length > 0) filter.push('--', ...pathspec)
    const raw = await this.g(['diff-tree', '-r', '-z', '--raw', '--no-abbrev', '--no-renames', fromTree, toTree, ...filter])
    const rows = parseRaw(raw.stdout)
    if (rows.length === 0) return []
    // 指针与它里面的文件之间来回切换不是真正的改动，规则写在 foldPointers 里。
    const kept = foldPointers(rows)
    if (kept.length === 0) return []
    const counted = await this.g(['diff-tree', '-r', '-z', '--numstat', '--no-renames', fromTree, toTree, ...filter])
    const nums = parseNumstat(counted.stdout)
    const changes = kept.map((row) => {
      const num = nums.get(row.path) || { additions: 0, deletions: 0, binary: false }
      return {
        path: row.path,
        kind: row.status === 'A' ? 'added' : row.status === 'D' ? 'deleted' : 'modified',
        additions: num.additions,
        deletions: num.deletions,
        binary: num.binary,
        blob: row.newSha
      }
    })
    changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return changes
  }

  // 新的在前：往后的比较和「还原到检查点」都对着新的那个。
  latestBaseline(sessionId) {
    const rows = this.pointsOf(sessionId)
    return rows.length > 0 ? rows[0] : null
  }

  // 三种来路的检查点都从这里落：手动标的、会话开头的、分支出来的，只是 source 记的来路不同。
  // 检查点记在创建它的那条会话名下，对整棵树有效；同一棵树重复设点只留一份。
  // 点只记公共部分：轮次、时间、序号、来路；手动点另挂一份轮次记录的拷贝（entry），
  // 因为设点之后那条快照会被删掉，卡片要靠这份拷贝才画得全。开头点与分支点没有那条记录。
  async addCheckpoint(sessionId, turn, tree, source, seq, entry) {
    const key = String(sessionId)
    const line = this.lineOf(key)
    const point = { turn, time: Date.now(), seq, source }
    if (entry !== undefined && entry !== null) point.entry = entry
    line.point[tree] = point
    const record = { tree, time: point.time, sessionId: key, turn, seq, source, entry: point.entry || null }
    // 这一轮已经有检查点了，之前那个「扫过没改动」的记号就没用了。
    if (line.blank !== undefined) delete line.blank[String(turn)]
    // 检查点得有一条引用自己拴着，否则下一次 gc 会当垃圾收走。
    const pinned = await this.commitTree(tree, [], 'file-history checkpoint ' + source)
    await this.g(['update-ref', 'refs/checkpoints/' + tree, pinned], { allowFail: true })
    return record
  }

  // 删掉一个检查点：它记在哪条会话名下就只动那一条，然后把失去引用的提交交给 pruneRefs 收走。
  // 检查点里抄着父树、统计与逐文件改动，够拼回一条快照——删点只是撤掉记号，这一轮的记录不丢。
  async dropPoint(tree) {
    let removed = 0
    for (const [key, line] of Object.entries(this.state.lines)) {
      const point = line.point === undefined ? undefined : line.point[tree]
      if (point === undefined) continue
      // 只有手动点带着那条轮次记录：删点等于把它还原成快照；开头点与分支点本来就没有记录可还。
      if (point.entry !== undefined && line.turn[String(point.turn)] === undefined) {
        line.turn[String(point.turn)] = this.entryFrom(key, point, tree)
      }
      delete line.point[tree]
      removed += 1
    }
    if (removed === 0) return { removed }
    await this.pruneRefs()
    await this.persist()
    return { removed }
  }

  // 「开头点」只有一条规则：这一棵树的检查点空了才补，而且补的是开始前的那棵树。
  // 它不属于任何一轮，轮次与序号都记 0，界面按「会话开始时的样子」显示。
  async ensureOrigin(sessionId, tree) {
    if (this.pointsOf(sessionId).length > 0) return false
    await this.addCheckpoint(sessionId, 0, tree, 'origin', 0)
    return true
  }

  // 这一刻磁盘与这一家最新检查点的差异；上一轮刚扫过就直接用那棵树。
  async baseline(sessionId) {
    if (this.idle(sessionId)) return { baseline: null, changes: [], stats: null }
    const latest = this.latestBaseline(sessionId)
    if (latest === null) return { baseline: null, changes: [], stats: null }
    // 上一轮刚扫过的那棵树只有它自己的会话能用：别的会话来问，问的是另一件东西。
    const fresh = this.freshTree !== null && this.freshTree.sessionId === sessionId ? this.freshTree.tree : null
    this.freshTree = null
    const current = fresh !== null ? fresh : (await this.capture(sessionId)).tree
    if (current === latest.tree) {
      return { baseline: latest, changes: [], stats: { files: 0, additions: 0, deletions: 0, binary: 0 } }
    }
    // 老检查点里还留着后来被排除的文件，不比掉它们，改动条就会冒出一串「删除」，还原时还会照着删。
    const changes = await this.diffTrees(latest.tree, current, this.spec(this.treeCfg(sessionId)))
    return { baseline: latest, changes, stats: summarize(changes) }
  }

  // 往前找最后一份文件历史：先看自己这条线（轮次不大于 turn），再看祖先分叉前的那一版。
  traceTree(sessionId, turn) {
    const own = this.lineTurns(sessionId)
    for (let i = own.length - 1; i >= 0; i -= 1) {
      if (own[i].turn <= turn) return own[i].tree
    }
    let at = this.parentOf(String(sessionId))
    for (let depth = 0; depth < 32 && at !== null && at !== undefined && at !== ''; depth += 1) {
      const rows = this.lineTurns(at)
      if (rows.length > 0) return rows[rows.length - 1].tree
      at = this.parentOf(String(at))
    }
    return null
  }

  // 设检查点就是「把这一版留下来」，一条文件历史必须唯一对应一个轮次：
  // - 这一轮有快照：快照换成检查点，同一轮只留一条记录，关联的轮次不变；
  // - 这一轮没有改动：取往前最后一次有差异的那份快照；
  // - 一条快照都没有：只有当前轮次能现拍，别的轮次没有那棵树，做不了。
  async setBaseline(sessionId, turn, tree, seq, current) {
    if (this.idle(sessionId)) throw new Error('这条会话已经关掉文件历史，先打开再设检查点。')
    const line = this.lineOf(sessionId)
    // 恢复或裁剪过的会话可能没有 turn/start 事件，位置就是空的：退回这条线最后记过的轮次。
    const known = Object.keys(line.turn).map(Number)
    const at = Number.isFinite(Number(turn)) ? Number(turn) : known.length === 0 ? 0 : Math.max.apply(null, known)
    let base
    if (typeof tree === 'string' && tree !== '') {
      base = { tree, turn: at }
    } else {
      // 没有改动时把能溯源到的那份快照复制成本轮的；溯源断了就明说做不了，不凭空造一版。
      const trace = this.traceTree(sessionId, at)
      if (trace === null) throw new Error('这一轮往前没有文件历史，没法设检查点。')
      base = { tree: current === true ? (await this.capture(sessionId)).tree : trace, turn: at }
    }
    const latest = this.latestBaseline(sessionId)
    // 和最新那个检查点毫无差异时不存：再存一次只换了个时间戳，列表里却多一个同内容的点。
    const stats = { files: 0, additions: 0, deletions: 0, binary: 0 }
    // 和最新检查点同一版：不存新的，但「这一版」就是那一版，调用方要知道停在哪。
    if (latest !== null && latest.tree === base.tree) return { skipped: true, baseline: latest, tree: latest.tree, changes: [], stats }
    // 一个轮次只能对应一个点：快照换成检查点，那条记录整份挂到点上，卡片才画得全。
    const entry = line.turn[String(base.turn)]
    const replaced = entry !== undefined
    const record = await this.addCheckpoint(sessionId, base.turn, base.tree, 'manual', seq,
      entry === undefined ? null : {
        base: typeof entry.base === 'string' ? entry.base : base.tree,
        startSeq: entry.startSeq || 0,
        endSeq: entry.endSeq || 0,
        commit: entry.commit || null,
        changes: Array.isArray(entry.changes) ? entry.changes : [],
        skipped: entry.skipped || 0,
        capped: entry.capped || 0,
        repos: Array.isArray(entry.repos) ? entry.repos : []
      })
    // 这一轮成了最末一条记录：撤销要退到它开始前那一版，把那份临时树也钉住。
    if (entry !== undefined && typeof entry.base === 'string' && entry.base !== '') {
      await this.g(['update-ref', 'refs/temp/base', entry.base], { allowFail: true })
    }
    if (replaced) delete line.turn[String(base.turn)]
    // 手动点在账本里会把比它更早的轮次吸收掉，所以刚设完就裁一次。
    const before = this.countEntries()
    await this.maintain()
    // 裁掉多少要当场说：轮次从时间线上消失得有个解释。
    const pruned = before - this.countEntries()
    await this.persist()
    return { skipped: false, baseline: record, tree: base.tree, changes: [], stats, pruned, replaced }
  }

  // 还原到检查点：撤销点记在按下还原的那条会话名下。
  async revertBaseline(sessionId, tree, force) {
    const wanted = typeof tree === 'string' && tree !== '' ? tree : null
    const rows = this.pointsOf(sessionId)
    const record = wanted === null ? rows[0] || null : rows.find((row) => row.tree === wanted) || null
    if (!record) throw new Error('这个工作区没有检查点')
    return this.revertTree(record.sessionId, record.tree, force)
  }

  // 工作区的第一份快照只当锚点：它不上报改动。
  async snapshot(meta) {
    const sessionId = String(meta.sessionId)
    const conf = this.treeCfg(sessionId)
    const line = this.lineOf(sessionId)
    // 关掉检查就是整件事都停了：这一轮不扫盘也不记账，只把等着的客户端放开。
    if (conf.off === true) {
      this.wake(sessionId, meta.turn, null)
      return null
    }
    // 不逐轮拍快照时，这一轮只补一件东西：这条线还没有检查点就补一个开头的。
    if (conf.auto === false) {
      const startTree = typeof meta.startTree === 'string' && meta.startTree !== '' ? meta.startTree : (await this.capture(sessionId)).tree
      if (await this.ensureOrigin(sessionId, startTree)) await this.persist()
      this.wake(sessionId, meta.turn, null)
      return null
    }
    const lineRef = 'refs/lines/' + sessionId
    // 线的头就是 refs/lines/<会话> 指向的提交：不再另存一份 tip，免得三处指向同一个提交。
    const parentCommit = typeof meta.baseCommit === 'string' && meta.baseCommit !== '' ? meta.baseCommit : await this.lineTip(lineRef)
    const first = parentCommit === null
    const startTree = typeof meta.startTree === 'string' && meta.startTree !== '' ? meta.startTree : null
    // 没有父提交、也没有 turn/start 存下的树，这一版只能是锚点：它不记账，也就没有可比的起点。
    const anchorOnly = first && startTree === null
    const captured = await this.capture(sessionId)
    this.freshTree = { sessionId, tree: captured.tree }
    // 开头点记的是「开始前」那一版：这一轮本身改的东西不该算进起点。
    await this.ensureOrigin(sessionId, startTree !== null ? startTree : captured.tree)
    // 父提交可能已经被 gc 删掉了：引用还在、对象没了。这时没法相减，就把这一轮当新起点。
    const parentTree = startTree !== null ? startTree : first ? captured.tree : await this.treeOf(parentCommit).catch(() => null)
    // 父提交的对象被回收了：引用还在、树没了。这时比不出差异，只能把这一轮当新起点，
    // 但不能记成「扫过没变」——那会把真实改动藏起来，卡片只留一颗设为检查点。
    const lost = !first && startTree === null && parentTree === null
    const baseTree = parentTree === null ? captured.tree : parentTree
    // base 是临时的一版，不进历史链：用一条引用钉住**最新**那份就够了——撤销只挂在最末一条记录上，
    // 更早的 base 没人再用。不钉的话它没有提交引用，裁剪后的 prune 会当垃圾收走。
    await this.g(['update-ref', 'refs/temp/base', baseTree], { allowFail: true })
    const changes = anchorOnly || lost ? [] : await this.diffTrees(baseTree, captured.tree, this.spec(conf))
    // 两张书签一起挪，比按张数叫几次 git 省几次进程启动。
    const moveLine = async (commit) => {
      await this.g(['update-ref', '--stdin'], {
        input: 'update ' + lineRef + ' ' + commit + '\nupdate refs/lines/main ' + commit + '\n'
      })
    }
    if (anchorOnly) {
      const anchor = await this.commitTree(captured.tree, [], 'file-history anchor')
      await moveLine(anchor)
      await this.persist()
      this.wake(sessionId, meta.turn, null)
      return null
    }
    if (lost) {
      const anchor = await this.commitTree(captured.tree, [parentCommit], 'file-history re-anchor')
      await moveLine(anchor)
      await this.persist()
      this.wake(sessionId, meta.turn, null)
      return null
    }
    // 没有改动的轮次不留快照，但要留一个记号：以后要靠它区分「扫过但没变」和「根本没扫」（自动快照关着）。
    if (changes.length === 0) {
      line.blank[String(meta.turn)] = Date.now()
      await this.persist()
      this.wake(sessionId, meta.turn, null)
      return null
    }
    // 落盘的只有磁盘事实：轮次与所属会话由外层的键决定，统计由 changes 现算，不各存一份。
    const entry = {
      time: Date.now(),
      startSeq: meta.startSeq || 0,
      endSeq: meta.endSeq || 0,
      base: baseTree,
      tree: captured.tree,
      changes,
      skipped: (captured.skipped && captured.skipped.count) || 0,
      capped: (captured.skipped && captured.skipped.capped) || 0,
      repos: captured.repos
    }
    // 第一轮带着 turn/start 的树时还没有父提交，这条线从它开始。
    entry.commit = await this.commitTree(captured.tree, parentCommit === null ? [] : [parentCommit], 'file-history turn ' + String(meta.turn))
    await moveLine(entry.commit)
    line.turn[String(meta.turn)] = entry
    await this.maintain()
    await this.persist()
    // 每轮留下的是新对象，旧的那些没人再引用也不会自己消失，要等回收。
    await this.g(['gc', '--auto', '--quiet'], { allowFail: true, env: { GIT_INDEX_FILE: this.indexFile } })
    this.usageCache = null
    // 账本落盘之后才叫醒等待的客户端：它们被唤醒时读到的必然包含这一轮。
    const shaped = this.hydrate(sessionId, meta.turn, entry)
    this.wake(sessionId, meta.turn, shaped)
    return shaped
  }

  wake(sessionId, turn, entry) {
    const key = String(sessionId) + '#' + String(turn)
    const waiter = this.waiters.get(key)
    if (waiter === undefined) return
    this.waiters.delete(key)
    waiter(entry)
  }

  // 账本是历史的有限视图：裁掉行永远不删提交，因为线引用还够得着它们，只有走不到的对象才被回收。
  async maintain() {
    // 裁到倒数第几个检查点由这棵树自己说了算；插件配置只是新树的默认值。
    const limitOf = (root) => {
      const value = this.treeCfg(root).prune
      return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : DEFAULTS.pruneAfterCheckpoints
    }
    // 每条分支各算各的窗口：一条冷掉的分支不该决定另一条能留几轮。
    const trees = new Map()
    for (const [id, line] of Object.entries(this.state.lines)) {
      const root = this.rootOf(id)
      let row = trees.get(root)
      if (row === undefined) {
        row = []
        trees.set(root, row)
      }
      for (const [tree, point] of Object.entries(line.point)) row.push(Object.assign({ tree }, point))
    }
    for (const row of trees.values()) row.sort((left, right) => right.time - left.time)
    // 切点取这棵树倒数第 N 个检查点：比它更早的轮次已经没有对照价值。
    const survivors = new Map()
    for (const [id, line] of Object.entries(this.state.lines)) {
      const turns = Object.keys(line.turn).map(Number).sort((left, right) => left - right)
      if (turns.length === 0) continue
      const root = this.rootOf(id)
      const points = trees.get(root)
      const kept = limitOf(root)
      const keep = new Set()
      // 第一道：最近 M 轮。0 表示不按轮次裁，全都过这一道。
      const recent = this.treeCfg(root).keep
      const floor = recent > 0 ? Math.max(0, turns.length - recent) : 0
      for (let i = floor; i < turns.length; i += 1) keep.add(turns[i])
      // 第二道：检查点那条线。两道都满足才留下——落在最近 M 轮里、但早于切点的，照样删。
      if (kept > 0 && points.length >= kept) {
        const cut = points[kept - 1].time
        for (const turn of turns) if (line.turn[String(turn)].time < cut) keep.delete(turn)
      }
      survivors.set(id, keep)
    }
    // 总量上限：从最老的轮次开始丢。
    let total = 0
    for (const keep of survivors.values()) total += keep.size
    let extra = Math.max(0, total - this.options.maxEntries)
    if (extra > 0) {
      const order = []
      for (const [id, keep] of survivors) {
        for (const turn of keep) order.push({ id, turn, time: this.state.lines[id].turn[String(turn)].time })
      }
      order.sort((left, right) => left.time - right.time)
      for (const row of order) {
        if (extra <= 0) break
        survivors.get(row.id).delete(row.turn)
        extra -= 1
      }
    }
    // 只有账本真的裁掉行，才有引用消失、才需要回收。
    let removed = 0
    for (const [id, line] of Object.entries(this.state.lines)) {
      const keep = survivors.get(id)
      let floor = null
      for (const turn of Object.keys(line.turn)) {
        if (keep !== undefined && keep.has(Number(turn))) {
          const time = line.turn[turn].time
          if (floor === null || time < floor) floor = time
          continue
        }
        delete line.turn[turn]
        removed += 1
      }
      // 空轮次只留比最老的存活快照更新的那些；一条快照都没留下时最多留 50 个，账本不该被记号撑大。
      const blanks = Object.keys(line.blank || {})
      if (blanks.length === 0) continue
      if (floor === null) {
        blanks.sort((left, right) => line.blank[left] - line.blank[right])
        for (const turn of blanks.slice(0, Math.max(0, blanks.length - 50))) delete line.blank[turn]
        continue
      }
      for (const turn of blanks) if (line.blank[turn] < floor) delete line.blank[turn]
    }
    if (removed === 0) return
    await this.pruneRefs()
    await this.g(['reflog', 'expire', '--expire=now', '--all'], { allowFail: true })
    // 每裁掉一行就整库 gc 太重（稳态下每轮都会裁一行）。先把不可达对象删掉，
    // 打包交给每轮末尾的 gc --auto，它只在对象够多时才真的动手。
    await this.g(['prune', '--expire=now'], { allowFail: true })
  }

  // 账本才是「还留着的历史」的真源：一条线在账本里再没有任何一行，它的引用就该消失。
  async pruneRefs() {
    const liveLines = new Set()
    let newest = null
    for (const [id, line] of Object.entries(this.state.lines)) {
      const turns = Object.values(line.turn)
      // 最后一轮被升成检查点之后这条线没有轮次了，但检查点还挂在这条线上：引用得留着，下次拍快照才接得上。
      if (turns.length > 0 || Object.keys(line.point).length > 0) liveLines.add('refs/lines/' + id)
      for (const entry of turns) if (newest === null || entry.time > newest.time) newest = entry
    }
    const livePoints = new Set()
    const points = []
    for (const line of Object.values(this.state.lines)) {
      for (const [tree, point] of Object.entries(line.point)) {
        livePoints.add('refs/checkpoints/' + tree)
        points.push(Object.assign({ tree }, point))
      }
    }
    // 先把现有的引用一次问清：每个点单跑一次 rev-parse 是这里最贵的地方。
    const listed = await this.g(['for-each-ref', '--format=%(refname)', 'refs/lines/', 'refs/checkpoints/'], { allowFail: true })
    const existing = new Set()
    if (listed.code === 0) {
      for (const ref of listed.stdout.toString('utf8').split('\n')) {
        const name = ref.trim()
        if (name !== '') existing.add(name)
      }
    }
    // 老账本里的点还没有自己的引用，这里补上：不补的话它们撑不过下一次 gc。
    for (const row of points) {
      const ref = 'refs/checkpoints/' + row.tree
      if (existing.has(ref)) continue
      const pinned = await this.commitTree(row.tree, [], 'file-history checkpoint ' + (row.source || 'manual'))
      await this.g(['update-ref', ref, pinned], { allowFail: true })
      existing.add(ref)
    }
    // 要删的引用合成一条 update-ref：一条分支一个进程在这里会排成队。
    const deletes = []
    for (const ref of existing) {
      // main 是「最近一条线」的别名，不能按会话清掉，单独跟着最新一行走。
      if (ref === 'refs/lines/main') continue
      if (liveLines.has(ref) || livePoints.has(ref)) continue
      deletes.push('delete ' + ref)
    }
    if (deletes.length > 0) {
      await this.g(['update-ref', '--stdin'], { allowFail: true, input: deletes.join('\n') + '\n' })
    }
    if (newest !== null) await this.g(['update-ref', 'refs/lines/main', newest.commit], { allowFail: true })
  }

  // 用户主动清掉这一家的历史：turns 只抹流水账，all 连检查点一起抹。两种都只动这一家。
  // isMine 判断某条会话是不是这一家的：传的是会话 id，不是某一行。
  async dropHistory(scope, isMine) {
    let removed = 0
    for (const [id, line] of Object.entries(this.state.lines)) {
      if (!isMine(id)) continue
      removed += Object.keys(line.turn).length
      line.turn = {}
      if (scope === 'all') {
        removed += Object.keys(line.point).length
        line.point = {}
      }
      line.blank = {}
    }
    // 账本里没有这一家的行也要往下走：磁盘上的旧对象还在，用户按下清除就是想让它们消失。
    // 账本先落盘：回收万一失败，至少记录已经清干净。
    await this.persist()
    await this.pruneRefs()
    // 钉住的那份临时 base 也一并放掉，否则 gc 之后它还占着一棵树。
    await this.g(['update-ref', '-d', 'refs/temp/base'], { allowFail: true })
    await this.g(['reflog', 'expire', '--expire=now', '--all'], { allowFail: true })
    // 扫描用的索引在 repo.git 外面，git 会把里面引用的每一份内容都当作活着的对象。
    await fsp.rm(this.indexFile, { force: true })
    await fsp.rm(path.join(this.repo, 'index'), { force: true })
    const collected = await this.g(['gc', '--prune=now', '--quiet'], { allowFail: true })
    if (collected.code !== 0) throw new Error('历史已清空，但 git 回收失败：' + collected.stderr.toString('utf8').trim())
    this.usageCache = null
    return { removed }
  }

  async lineTip(lineRef) {
    const found = await this.g(['rev-parse', '--verify', '--quiet', lineRef], { allowFail: true })
    if (found.code !== 0) return null
    return found.stdout.toString('utf8').trim() || null
  }

  async treeOf(commit) {
    const out = await this.g(['rev-parse', commit + '^{tree}'])
    return out.stdout.toString('utf8').trim()
  }

  // 给 tree 在 parentCommits 之上写一个 commit；一条线的第一份快照没有父。
  async commitTree(tree, parentCommits, message) {
    // commit-tree 本身不跑钩子也不签名，但把这两条钉死是有意的：换成 git commit 时行为不该悄悄变。
    const args = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit-tree', tree]
    for (const parentCommit of parentCommits) args.push('-p', parentCommit)
    args.push('-m', message)
    const out = await this.g(args)
    return out.stdout.toString('utf8').trim()
  }

  // 落盘的轮次记录不带轮次号、会话 id 和统计：它们分别由键与 changes 决定，读的时候补齐。
  hydrate(sessionId, turn, raw) {
    return Object.assign({}, raw, { sessionId: String(sessionId), turn: Number(turn), stats: summarize(raw.changes) })
  }

  find(sessionId, turn) {
    const line = this.state.lines[String(sessionId)]
    if (line === undefined || line === null) return null
    const raw = line.turn[String(turn)]
    return raw === undefined ? null : this.hydrate(sessionId, turn, raw)
  }

  // 手动点里挂着那份轮次记录的拷贝，拼回原来那条快照的形状。
  entryFrom(sessionId, point, tree) {
    const copy = point.entry && typeof point.entry === 'object' ? point.entry : {}
    return {
      sessionId: String(sessionId),
      turn: point.turn,
      time: point.time,
      startSeq: copy.startSeq || 0,
      endSeq: copy.endSeq || 0,
      base: typeof copy.base === 'string' && copy.base !== '' ? copy.base : tree,
      tree,
      changes: Array.isArray(copy.changes) ? copy.changes : [],
      stats: summarize(Array.isArray(copy.changes) ? copy.changes : []),
      skipped: copy.skipped || 0,
      capped: copy.capped || 0,
      repos: Array.isArray(copy.repos) ? copy.repos : [],
      commit: copy.commit || null
    }
  }

  // 某一轮的文件历史：有快照就是快照，被设成检查点的轮次用它抄下的字段拼出来。
  entryAt(sessionId, turn) {
    const entry = this.find(sessionId, turn)
    if (entry !== null) return entry
    const line = this.state.lines[String(sessionId)]
    if (line === undefined || line === null) return null
    // 任何点都能拼出一条记录：手动点带着整份拷贝，开头点与分支点只有一棵树，
    // 拼出来就是「这一轮的文件清单为空」——还原和分支靠的本来就是轮次号与树，不是清单。
    for (const [tree, point] of Object.entries(line.point)) {
      if (point.turn === Number(turn)) return this.entryFrom(sessionId, point, tree)
    }
    return null
  }

  // 客户端拿到轮次闭合信号时，宿主的快照可能还没写完：让请求挂到写完为止，而不是让客户端猜时间。
  wait(sessionId, turn, timeoutMs) {
    const known = this.find(sessionId, turn)
    if (known !== null) return Promise.resolve(known)
    const key = String(sessionId) + '#' + String(turn)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key)
        resolve(null)
      }, timeoutMs)
      this.waiters.set(key, (entry) => {
        clearTimeout(timer)
        resolve(entry)
      })
    })
  }

  // 把工作树改写回目标树。绝不整树 checkout：快照故意忽略的文件不能因为不在树里就被删掉。
  async revertTo(targetTree, fromTree, pathspec) {
    // 目标树是空的时候，对比出来的每一条都是「删除」，真照做会把整个工作区清空。
    const listing = await this.g(['ls-tree', '-r', '--name-only', targetTree], { allowFail: true })
    if (listing.code === 0 && listing.stdout.toString('utf8').trim() === '') {
      return { tree: targetTree, written: 0, removed: 0, empty: true }
    }
    // 调用方刚扫过盘就把那棵树递进来，省一次整盘扫描；没给就自己扫。
    const current = fromTree === undefined ? (await this.capture()).tree : fromTree
    const rows = await this.diffTrees(current, targetTree, pathspec)
    const removed = []
    const failures = []
    const writes = new Map()
    for (const row of rows) {
      if (row.kind === 'deleted') {
        const absolute = path.join(this.root, ...row.path.split('/'))
        try {
          await fsp.rm(absolute, { force: true })
          await this.pruneEmpty(path.dirname(absolute))
          removed.push(row.path)
        } catch (error) {
          failures.push('删除 ' + row.path + '：' + (error && error.message ? error.message : String(error)))
        }
        continue
      }
      const list = writes.get(row.blob) || []
      list.push(row.path)
      writes.set(row.blob, list)
    }
    const shas = Array.from(writes.keys())
    let written = 0
    for (let i = 0; i < shas.length; i += 400) {
      const slice = shas.slice(i, i + 400)
      const result = await this.g(['cat-file', '--batch'], {
        input: Buffer.from(slice.map((sha) => sha + '\n').join(''), 'utf8')
      })
      const blobs = parseBatchBlobs(result.stdout)
      for (const sha of slice) {
        const content = blobs.get(sha)
        // 对象被回收或仓库损坏时这些文件写不出来，要算进失败，不能当成「没这条」悄悄跳过。
        if (content === undefined) {
          for (const relative of writes.get(sha)) failures.push('写入 ' + relative + '：快照里已经没有这份内容')
          continue
        }
        for (const relative of writes.get(sha)) {
          const absolute = path.join(this.root, ...relative.split('/'))
          try {
            await fsp.mkdir(path.dirname(absolute), { recursive: true })
            await fsp.writeFile(absolute, content)
            written += 1
          } catch (error) {
            failures.push('写入 ' + relative + '：' + (error && error.message ? error.message : String(error)))
          }
        }
      }
    }
    // 有文件没还原成功就整次报错，并把已经改了多少带出去：磁盘停在半路这件事必须让用户知道。
    if (failures.length > 0) {
      const error = new Error('还原没做完：' + failures.length + ' 个文件失败，已改 ' + (written + removed.length) + ' 个')
      error.failures = failures
      throw error
    }
    return { tree: current, written, removed: removed.length }
  }

  async pruneEmpty(directory) {
    let current = directory
    while (current.length > this.root.length && current.startsWith(this.root)) {
      try {
        await fsp.rmdir(current)
      } catch {
        return
      }
      current = path.dirname(current)
    }
  }

  // 上一次记录到现在，磁盘上有没有被外面改过的文件：还原会盖掉它们，所以先数一遍。
  async outsideCount(sessionId, current, turn) {
    // 磁盘正好是自己刚写过的那一版：外面没人动过，不用问。
    if (this.wrote[sessionId] === current) return 0
    const turns = this.lineTurns(sessionId)
    // 目标是一份更早的版本时，比的就是它后面的那些轮次，不是这条线最后一条。
    const later = typeof turn === 'number' ? turns.filter((row) => row.turn > turn) : turns.slice(-1)
    if (later.length === 0) return 0
    const changed = await this.diffTrees(later[later.length - 1].tree, current, this.spec(this.treeCfg(sessionId)))
    return changed.length
  }

  // 还原只有一套骨架：扫一次盘、看目标是不是已经就是磁盘、数一遍外面改过的文件，问过再写回。
  // 落点由调用方算好传进来；数外部改动可以从「某一轮之后」数，也可以从「某一版之后」数。
  async revertTree(sessionId, wanted, force, atTurn, from) {
    const key = String(sessionId)
    const current = (await this.capture(key)).tree
    // 目标就是磁盘现在这一版：没有要盖的东西，也就不必问「外面改过要不要覆盖」。
    if (wanted === current) return { written: 0, removed: 0 }
    // 有手改没记进快照时先问一句，别让一次误点把手上的活盖掉。
    const outside = typeof from === 'string' && from !== ''
      ? from === current || this.wrote[key] === current
        ? 0
        : (await this.diffTrees(from, current, this.spec(this.treeCfg(key)))).length
      : await this.outsideCount(key, current, atTurn)
    if (outside > 0 && force !== true) return { confirm: outside }
    const result = await this.revertTo(wanted, current, this.spec(this.treeCfg(key)))
    this.wrote[key] = wanted
    return result
  }

  // 撤销这一轮带来的改动，落点是这一轮开始前的那一版（记录里的 base）。只读这条线索自己的记录，
  // 更早的行被裁掉也照样能退。比较外部改动的起点是这一轮自己做出来的那一版。
  async undoRevert(sessionId, tree, turn, force) {
    const line = this.lineOf(sessionId)
    // 检查点换下这一轮时，整份记录（含 base）也跟着搬了过去。
    const record = typeof turn === 'number' ? this.find(sessionId, turn) : null
    const copy = typeof tree === 'string' && tree !== '' ? (line.point[tree] || {}).entry || null : null
    const back = record !== null ? record.base : copy !== null ? copy.base : null
    if (typeof back !== 'string' || back === '') throw new Error('这一轮没有可退的记录')
    const from = typeof tree === 'string' && tree !== '' ? tree : record === null ? undefined : record.tree
    return this.revertTree(sessionId, back, force, undefined, from)
  }
}
