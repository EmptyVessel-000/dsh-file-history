// dsh-file-history 的宿主侧。
// 每一轮对话结束存一份快照，放在 DSH_HOME 下的影子 git 仓库里，用户项目的 .git 一概不碰。
// 顺次是：默认值、git 底层调用、Workspace（快照与还原）、History（事件与 RPC）、注册。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-file-history'
export const inject = ['sessions', 'connection']

const CHANNEL = '/dsh-file-history'
const LEDGER_VERSION = 1
const EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const DEFAULTS = {
  excludes: [
    'node_modules/',
    '.git/',
    '.svn/',
    'dist/',
    'build/',
    'target/',
    'out/',
    'bin/',
    'obj/',
    '.vs/',
    '.idea/',
    '.vscode/',
    '__pycache__/',
    '.venv/',
    '.next/',
    '.cache/',
    '*.zip',
    '*.7z',
    '*.jar',
    '*.pch',
    '*.db'
  ],
  maxFileBytes: 5 * 1024 * 1024,
  maxEntries: 100,
  // 自动裁剪的切点取倒数第几个手动检查点：2 就是最近两个手动点里较早的那个。
  pruneAfterCheckpoints: 2,
  // 一个手动点都没有时按最近多少轮裁；不设这一条，账本只能一直涨到 maxEntries 才动手。
  keepRecentTurns: 20,
  // 规模失控时只降级记录，不碰磁盘：单个目录的文件数超过这条线，这个目录就整块不进快照。
  maxDirFiles: 20000,
  // 整个工作区加起来的字节数上限，超了从最大的文件开始让位，直到回到预算内。
  maxBytes: 2 * 1024 * 1024 * 1024,
  gcIntervalMs: 10 * 60 * 1000
}

function stateRoot() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'file-history')
}

function keyFor(root) {
  return createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex')
}

function run(bin, args, options) {
  const opts = options || {}
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        env: Object.assign({}, process.env, opts.env || {}),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.from(String(error && error.message)) })
      return
    }
    const out = []
    const err = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.on('error', (error) => {
      resolve({ code: -1, stdout: Buffer.concat(out), stderr: Buffer.from(String(error && error.message)) })
    })
    child.on('close', (code) => {
      resolve({ code: code === null ? -1 : code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) })
    })
    if (opts.input === undefined || opts.input === null) child.stdin.end()
    else child.stdin.end(opts.input)
  })
}

// diff-tree --raw -z 输出成对的 "<header>\0<path>\0"，header 形如 ":mode mode sha sha status"。
function parseRaw(buffer) {
  const parts = buffer.toString('utf8').split('\u0000')
  const rows = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const head = parts[i]
    if (!head || head.charAt(0) !== ':') continue
    const fields = head.slice(1).split(' ')
    rows.push({
      status: (fields[4] || 'M').charAt(0),
      newSha: fields[3],
      path: parts[i + 1]
    })
  }
  return rows
}

function parseNumstat(buffer) {
  const map = new Map()
  for (const part of buffer.toString('utf8').split('\u0000')) {
    if (!part) continue
    const first = part.indexOf('\t')
    const second = first < 0 ? -1 : part.indexOf('\t', first + 1)
    if (second < 0) continue
    const add = part.slice(0, first)
    const del = part.slice(first + 1, second)
    const binary = add === '-' || del === '-'
    map.set(part.slice(second + 1), {
      additions: binary ? 0 : Number(add),
      deletions: binary ? 0 : Number(del),
      binary
    })
  }
  return map
}

// ls-files -s -z 每行是 "<mode> <sha> <stage>\t<path>\0"。
function parseLsFiles(buffer) {
  const rows = []
  for (const part of buffer.toString('utf8').split('\u0000')) {
    if (!part) continue
    const tab = part.indexOf('\t')
    if (tab < 0) continue
    rows.push({ sha: part.slice(0, tab).split(' ')[1], path: part.slice(tab + 1) })
  }
  return rows
}

// cat-file --batch 与 --batch-check 都回一行 "<sha> <type> <size>\n"。
function parseSizes(buffer) {
  const map = new Map()
  for (const line of buffer.toString('utf8').split('\n')) {
    const fields = line.split(' ')
    if (fields.length >= 3 && fields[1] === 'blob') map.set(fields[0], Number(fields[2]))
  }
  return map
}

// --batch 在这行之后紧跟 <size> 字节原文和一个换行，取内容时两者都要跳过。
function parseBatchBlobs(buffer) {
  const map = new Map()
  let offset = 0
  while (offset < buffer.length) {
    const end = buffer.indexOf(10, offset)
    if (end < 0) break
    const fields = buffer.toString('utf8', offset, end).split(' ')
    if (fields.length < 3 || fields[1] !== 'blob') {
      offset = end + 1
      continue
    }
    const size = Number(fields[2])
    const start = end + 1
    map.set(fields[0], buffer.subarray(start, start + size))
    offset = start + size + 1
  }
  return map
}

function summarize(changes) {
  const stats = { files: changes.length, additions: 0, deletions: 0, binary: 0 }
  for (const change of changes) {
    stats.additions += change.additions
    stats.deletions += change.deletions
    if (change.binary) stats.binary += 1
  }
  return stats
}

// 这里三种 sha 从不混用：commit 是历史里的一个点，tree 是一次快照的文件清单。
// blob 是一个文件的内容。git 有的命令拿 commit 当 tree 也认，有的只认一种。
// 所以每个存 sha 的变量都按类型命名，读的人不必回头确认。
class Workspace {
  constructor(root, git, options) {
    this.root = path.resolve(root)
    this.git = git
    this.options = options
    this.key = keyFor(this.root)
    this.dir = path.join(stateRoot(), this.key)
    this.repo = path.join(this.dir, 'repo.git')
    this.indexFile = path.join(this.dir, 'index')
    this.ledgerFile = path.join(this.dir, 'index.json')
    this.undoFile = path.join(this.dir, 'undo.json')
    this.ready = null
    this.queue = Promise.resolve()
    this.state = null
    this.undo = null
    this.lastError = null
    // 正在等快照的客户端：键是 sessionId#turn，值是唤醒函数。snapshot() 落盘后逐个叫醒。
    this.waiters = new Map()
    // 轮次结束刚扫出的树：改动条紧接着来读差异时直接用它，不必为同一瞬间再扫一遍。
    this.freshTree = null
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

  ensure() {
    if (this.ready === null) this.ready = this.setup()
    return this.ready
  }

  async setup() {
    await fsp.mkdir(this.dir, { recursive: true })
    if (!fs.existsSync(path.join(this.repo, 'HEAD'))) {
      const init = await run(this.git, ['init', '--bare', '--quiet', this.repo], {})
      if (init.code !== 0) throw new Error(init.stderr.toString('utf8').trim() || 'git init failed')
      await fsp.rm(this.indexFile, { force: true })
    }
    await fsp.mkdir(path.join(this.repo, 'info'), { recursive: true })
    const excludes = this.options.excludes
    await fsp.writeFile(path.join(this.repo, 'info', 'exclude'), excludes.join('\n') + '\n')
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
    this.undo = await this.loadUndo()
    return this
  }

  async loadLedger() {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.ledgerFile, 'utf8'))
      if (!parsed || parsed.version !== LEDGER_VERSION || !Array.isArray(parsed.entries)) throw new Error('stale ledger')
      parsed.big = Array.isArray(parsed.big) ? parsed.big : []
      // 旧账本只存一个检查点，读进来当成仅有的那一个；没写 source 的都是当年手动标的。
      const kept = Array.isArray(parsed.baselines) ? parsed.baselines : parsed.baseline ? [parsed.baseline] : []
      parsed.baselines = kept.map((row) => Object.assign({ source: 'manual' }, row))
      delete parsed.baseline
      return parsed
    } catch {
      return { version: LEDGER_VERSION, big: [], baselines: [], entries: [] }
    }
  }

  async loadUndo() {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.undoFile, 'utf8'))
      return parsed && typeof parsed.commit === 'string' ? parsed : null
    } catch {
      return null
    }
  }

  async persist() {
    const tmp = this.ledgerFile + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(this.state))
    await fsp.rename(tmp, this.ledgerFile)
  }

  async persistUndo() {
    if (this.undo === null) {
      await fsp.rm(this.undoFile, { force: true })
      return
    }
    const tmp = this.undoFile + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(this.undo))
    await fsp.rename(tmp, this.undoFile)
  }

  // 还超着大小限制的文件继续按 pathspec 排除，不会被重新哈希。
  // 变小之后自己就回来了，不需要谁去清标记。
  async bigStillBig() {
    const kept = []
    for (const relative of this.state.big) {
      try {
        const stat = await fsp.stat(path.join(this.root, ...relative.split('/')))
        if (stat.size > this.options.maxFileBytes) kept.push(relative)
      } catch {
        // 已经不在了，从清单里去掉。
      }
    }
    return kept
  }

  async capture() {
    await this.ensure()
    const env = { GIT_INDEX_FILE: this.indexFile }
    const big = await this.bigStillBig()
    const excludes = []
    let budget = 6000
    for (const relative of big) {
      budget -= relative.length + 16
      if (budget < 0) break
      excludes.push(':(exclude,literal)' + relative)
    }
    try {
      await this.g(['add', '-A', '--', '.'].concat(excludes), { env })
    } catch (error) {
      // 索引过期或坏掉都能靠重来一次修好，不必先猜它是怎么坏的。
      await fsp.rm(this.indexFile, { force: true })
      await this.g(['add', '-A', '--', '.'], { env })
    }
    const skipped = await this.dropBig(env, big)
    const tree = await this.g(['write-tree'], { env })
    return { tree: tree.stdout.toString('utf8').trim(), skipped }
  }

  async dropBig(env, known) {
    const listed = await this.g(['ls-files', '-s', '-z'], { env })
    const rows = parseLsFiles(listed.stdout)
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
    // 目录与总量的降级不写进 state.big：它取决于这一轮有多少文件，记死之后那个目录就再也进不来快照。
    const capped = new Set()
    const counted = new Map()
    let total = 0
    for (const row of rows) {
      total += sizes.get(row.sha) || 0
      const cut = row.path.lastIndexOf('/')
      const dir = cut < 0 ? '.' : row.path.slice(0, cut)
      counted.set(dir, (counted.get(dir) || 0) + 1)
    }
    for (const [dir, count] of counted) {
      if (count <= this.options.maxDirFiles) continue
      for (const row of rows) {
        const cut = row.path.lastIndexOf('/')
        if ((cut < 0 ? '.' : row.path.slice(0, cut)) === dir) capped.add(row.path)
      }
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
    await this.g(['update-index', '--force-remove', '-z', '--stdin'], {
      env,
      input: Buffer.from(Array.from(drop).map((relative) => relative + '\u0000').join(''), 'utf8')
    })
    return { count: drop.size, bytes, capped: capped.size }
  }

  // 路径过滤直接交给 git：给了 pathspec 就只比这些路径，没给就和以前一样比整棵树。
  async diffTrees(fromTree, toTree, pathspec) {
    const filter = []
    if (Array.isArray(pathspec) && pathspec.length > 0) filter.push('--', ...pathspec)
    const raw = await this.g(['diff-tree', '-r', '-z', '--raw', '--no-abbrev', '--no-renames', fromTree, toTree, ...filter])
    const rows = parseRaw(raw.stdout)
    if (rows.length === 0) return []
    const counted = await this.g(['diff-tree', '-r', '-z', '--numstat', '--no-renames', fromTree, toTree, ...filter])
    const nums = parseNumstat(counted.stdout)
    const changes = rows.map((row) => {
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

  // 一轮开始时先把「模型动手之前」的树存下来。它同时是这一轮的父树和差异的起点，
  // 所以扫描必须赶在模型编辑之前完成——这里 await，不放到轮次结束再去补。
  async startTree() {
    return (await this.capture()).tree
  }

  // 检查点之后磁盘随时可能变，账本刷不刷新都说明不了。像 IDE 一样重扫：add -A 加 write-tree
  // 没改动时写出的树 sha 和上次一样，比时间戳猜得准。轮次刚结束那一下是例外——那一刻刚扫过，
  // 再扫一遍问的还是同一个瞬间，所以直接拿它；读完即清，下次要差异时重新扫。
  async baseline() {
    const latest = await this.latestBaseline()
    if (latest === null) return { baseline: null, changes: [], stats: null }
    const fresh = this.freshTree
    this.freshTree = null
    const current = fresh !== null ? fresh : (await this.capture()).tree
    if (current === latest.tree) {
      return { baseline: latest, changes: [], stats: { files: 0, additions: 0, deletions: 0, skipped: 0 } }
    }
    const changes = await this.diffTrees(latest.tree, current)
    return { baseline: latest, changes, stats: summarize(changes) }
  }

  // 检查点按时间倒序，新的在前：往后的比较和「还原到检查点」都对着新的那个。
  async latestBaseline() {
    const kept = this.state.baselines || []
    return kept.length > 0 ? kept[0] : null
  }

  // 三种来路的检查点都从这里落：手动标的、会话开头的、分支出来的，只是 source 记的来路不同，存法一样。
  async addCheckpoint(sessionId, turn, tree, source, familyRoot) {
    const record = { tree, time: Date.now(), sessionId, turn, source, familyRoot: familyRoot || sessionId }
    this.state.baselines = [record].concat(this.state.baselines || []).sort((left, right) => right.time - left.time)
    // 检查点得有一条引用自己拴着。从改动条存的是「现在的磁盘」，那棵树没有任何提交指着它，
    // 下一次 gc 会当垃圾收走，等到还原时才发现对象已经没了。
    const pinned = await this.commitTree(tree, [], 'file-history checkpoint ' + source)
    await this.g(['update-ref', 'refs/checkpoints/' + tree, pinned], { allowFail: true })
    return record
  }

  async setBaseline(sessionId, turn, tree, familyRoot) {
    // 传了树就按它存——轮次卡片上按的是「那一条记录的那一版」；没传就是「现在」，
    // 改动条上按下等于把这会儿的差异一起收进检查点，磁盘留原样、只移动检查点的时间位置。
    const current = typeof tree === 'string' && tree !== '' ? { tree: tree, skipped: [] } : await this.capture()
    const latest = await this.latestBaseline()
    // 和最新那个检查点毫无差异时不存：再存一次只换了个时间戳，列表里却多一个同内容的点。
    const stats = { files: 0, additions: 0, deletions: 0, skipped: (current.skipped && current.skipped.count) || 0 }
    if (latest !== null && latest.tree === current.tree) return { skipped: true, baseline: latest, changes: [], stats }
    // 手动标的点不再限数量：留几个由用户自己决定，挤掉哪一个不该由代码替他挑。
    const record = await this.addCheckpoint(sessionId, turn, current.tree, 'manual', familyRoot)
    // 手动点在账本里会把比它更早的轮次吸收掉，所以刚设完就裁一次。
    await this.maintain()
    await this.persist()
    return { skipped: false, baseline: record, changes: [], stats }
  }


  // 还原到检查点和逐轮还原共用一个撤销点，撤销后仍能回到还原前的工作树。
  async revertBaseline(tree) {
    // 时间线上每个点都能还原：指定了哪一版就还原哪一版，没指定就退回最新那个。
    const wanted = typeof tree === 'string' && tree !== '' ? tree : null
    const record = wanted === null ? await this.latestBaseline() : (this.state.baselines || []).find((row) => row.tree === wanted) || null
    if (!record) throw new Error('这个工作区没有检查点')
    // 撤销点必须就是「按下之前磁盘的样子」。用手动改过的文件时光靠尖端树不够，
    // 那条线记的是上一轮结束时的状态，中间的手改会被撤销一并吞掉，所以这里真扫一次盘。
    const saved = await this.commitTree((await this.capture()).tree, [], 'file-history checkpoint undo point')
    await this.g(['update-ref', 'refs/undo/point', saved])
    // 撤销点先记好再动磁盘：半路失败时用户还得能按撤销，把已经改掉的退回去。
    this.undo = { commit: saved, sessionId: record.sessionId, turn: record.turn, time: Date.now() }
    await this.persistUndo()
    return this.revertTo(record.tree)
  }

  // 工作区的第一份快照只当基准：它不上报改动。
  // turn/start 没见过的轮次也按第一轮算，状态因此只有一种形状。
  async snapshot(meta) {
    // 这一轮的父树就是 turn/start 存下的那棵：模型动手之前的状态，和这一轮结束后的树相减
    // 就是这一轮真正改动的东西。没有它（进程中途重启、或第一轮）才退回按父提交取树。
    const sessionId = meta.sessionId
    const lineRef = 'refs/lines/' + sessionId
    const parentCommit = typeof meta.baseCommit === 'string' && meta.baseCommit !== '' ? meta.baseCommit : await this.lineTip(lineRef)
    const first = parentCommit === null
    const startTree = typeof meta.startTree === 'string' && meta.startTree !== '' ? meta.startTree : null
    // 没有父提交、也没有 turn/start 存下的树，这一版只能是锚点：它不记账，也就没有可比的起点。
    const anchorOnly = first && startTree === null
    const captured = await this.capture()
    // 这一刻磁盘的样子，留给紧接着来问「现在跟检查点差什么」的改动条用。
    this.freshTree = captured.tree
    // 会话开头那棵树要留一个点：裁剪轮次时它是这条线继续往下接的根，删了就再也对不上号。
    if (first && !(this.state.baselines || []).some((row) => row.source === 'origin' && row.sessionId === sessionId)) {
      await this.addCheckpoint(sessionId, meta.turn, captured.tree, 'origin', meta.familyRoot)
    }
    const baseTree = startTree !== null ? startTree : first ? captured.tree : await this.treeOf(parentCommit)
    const changes = anchorOnly ? [] : await this.diffTrees(baseTree, captured.tree)
    // 三张书签指向同一版：这个会话的线、整个工作区最新的线，以及「还原对话」开出的新会话的线。
    // 条件只判一次，三张一起挪；分三次叫 git 只是多花进程启动的时间。
    const moveLine = async (commit) => {
      const refs = ['update ' + lineRef + ' ' + commit, 'update refs/lines/main ' + commit]
      if (meta.endSessionId !== sessionId) refs.push('update refs/lines/' + meta.endSessionId + ' ' + commit)
      await this.g(['update-ref', '--stdin'], { input: refs.join('\n') + '\n' })
    }
    // 第一次快照没有可比的父树时只是锚点：它把这条线指到当前树，自己不记账。
    // 但只要 turn/start 存过树，这一轮就有真实的父，改动照样要记。
    if (anchorOnly) {
      const anchor = await this.commitTree(captured.tree, [], 'file-history anchor')
      await moveLine(anchor)
      // 这一轮也存过点，不落盘的话它跟着进程一起没了。
      await this.persist()
      return null
    }
    // 没有改动的轮次不记账：空条目既占列表也占快照历史，而它承载的信息是零。
    if (changes.length === 0) {
      // 但这一轮确实扫过了，等待它的客户端不该一直被挂着。
      const key = sessionId + '#' + String(meta.turn)
      const waiter = this.waiters.get(key)
      if (waiter !== undefined) {
        this.waiters.delete(key)
        waiter(null)
      }
      return null
    }
    const entry = {
      id: sessionId + '#' + String(meta.turn),
      sessionId,
      familyRoot: meta.familyRoot || sessionId,
      endSessionId: meta.endSessionId,
      turn: meta.turn,
      time: Date.now(),
      startSeq: meta.startSeq || 0,
      base: baseTree,
      tree: captured.tree,
      changes,
      stats: summarize(changes),
      // 降级的条数要跟着这一轮走：界面靠它说明「为什么这一轮记录得不全」。
      skipped: captured.skipped,
      capped: (captured.skipped && captured.skipped.capped) || 0
    }
    // 第一轮带着 turn/start 的树时还没有父提交，这条线从它开始。
    const parents = parentCommit === null ? [] : [parentCommit]
    entry.commit = await this.commitTree(captured.tree, parents, 'file-history turn ' + String(meta.turn))
    await moveLine(entry.commit)
    this.state.entries.push(entry)
    await this.maintain()
    this.undo = null
    await this.persistUndo()
    await this.persist()
    // 账本落盘之后才叫醒等待的客户端：它们被唤醒时读到的必然包含这一轮。
    const key = sessionId + '#' + String(meta.turn)
    const waiter = this.waiters.get(key)
    if (waiter !== undefined) {
      this.waiters.delete(key)
      waiter(entry)
    }
    return entry
  }

  // 账本是历史的有限视图：裁掉行永远不删提交，因为线引用还够得着它们，只有走不到的对象才被回收。
  async maintain() {
    const manual = (this.state.baselines || []).filter((row) => row.source === 'manual')
    const kept = this.options.pruneAfterCheckpoints
    // 切点取倒数第 N 个手动点：比它更早的轮次快照已经没有对照价值，留着只会把「还能还原去哪」说错。
    // 手动点不够 N 个时退回按轮次裁——一次都没标过的会话不该只能靠 maxEntries 兜底。
    let cut = 0
    if (manual.length >= kept) {
      const boundary = manual[kept - 1].time
      cut = this.state.entries.findIndex((entry) => entry.time >= boundary)
      if (cut < 0) cut = 0
    } else {
      cut = Math.max(0, this.state.entries.length - this.options.keepRecentTurns)
    }
    const overflow = this.state.entries.length - cut - this.options.maxEntries
    // 只有账本真的裁掉行，才有引用消失、才需要回收；没裁就没东西可收，叫一次 git 纯属白花。
    if (cut <= 0 && overflow <= 0) return
    this.state.entries.splice(0, cut + Math.max(0, overflow))
    await this.pruneRefs()
    // 断掉的引用要等回收才失效，所以这两步只在这里跑：有行被裁掉，才真的产生了不可达对象。
    await this.g(['reflog', 'expire', '--expire=now', '--all'], { allowFail: true })
    await this.g(['gc', '--prune=now', '--quiet'], { allowFail: true })
  }

  // 账本才是「还留着的历史」的真源。一条线在账本里再没有任何一行，它的引用就该消失，
  // 否则父链会把裁掉的轮次一直撑着，gc 永远回收不了那些对象。检查点的引用同理，只认账本里还在的点。
  async pruneRefs() {
    const liveLines = new Set()
    for (const entry of this.state.entries) {
      liveLines.add('refs/lines/' + entry.sessionId)
      if (entry.endSessionId) liveLines.add('refs/lines/' + entry.endSessionId)
    }
    const livePoints = new Set()
    // 老账本里的点还没有自己的引用，这里补上：不补的话它们撑不过下一次 gc。
    for (const row of this.state.baselines || []) {
      const ref = 'refs/checkpoints/' + row.tree
      livePoints.add(ref)
      const known = await this.g(['rev-parse', '--verify', '--quiet', ref], { allowFail: true })
      if (known.code === 0) continue
      const pinned = await this.commitTree(row.tree, [], 'file-history checkpoint ' + (row.source || 'manual'))
      await this.g(['update-ref', ref, pinned], { allowFail: true })
    }
    const listed = await this.g(
      ['for-each-ref', '--format=%(refname)', 'refs/lines/', 'refs/checkpoints/'],
      { allowFail: true }
    )
    if (listed.code === 0) {
      for (const line of listed.stdout.toString('utf8').split('\n')) {
        const ref = line.trim()
        if (ref === '') continue
        // main 是「最近一条线」的别名，不能按会话清掉，单独跟着最新一行走。
        if (ref === 'refs/lines/main') continue
        if (liveLines.has(ref) || livePoints.has(ref)) continue
        await this.g(['update-ref', '-d', ref], { allowFail: true })
      }
    }
    const newest = this.state.entries.length > 0 ? this.state.entries[this.state.entries.length - 1].commit : null
    if (newest === null) await this.g(['update-ref', '-d', 'refs/lines/main'], { allowFail: true })
    else await this.g(['update-ref', 'refs/lines/main', newest], { allowFail: true })
  }

  // 用户主动清掉自己这条线的历史。取 turns 时只抹流水账、检查点全留；取 all 时连点一起抹，回到刚装插件的样子。
  // 两种都只动这一家的记录：同一个工作区里别的会话的轮次和点跟它无关。
  async dropHistory(scope, familyRoot) {
    const owner = (row) => row.familyRoot || row.sessionId || null
    const before = this.state.entries.length + (this.state.baselines || []).length
    this.state.entries = this.state.entries.filter((entry) => owner(entry) !== familyRoot)
    if (scope === 'all') {
      this.state.baselines = (this.state.baselines || []).filter((row) => owner(row) !== familyRoot)
    }
    const removed = before - (this.state.entries.length + (this.state.baselines || []).length)
    if (removed === 0) return { removed: 0 }
    await this.pruneRefs()
    await this.g(['reflog', 'expire', '--expire=now', '--all'], { allowFail: true })
    await this.g(['gc', '--prune=now', '--quiet'], { allowFail: true })
    // 撤销点指向的那一版可能刚被清掉，留着按钮只会点出一个还原不回来的空操作。
    this.undo = null
    await this.persistUndo()
    await this.persist()
    return { removed }
  }

  // 线引用指向一个 commit，比对用的是它里面那棵树。
  async lineTip(lineRef) {
    const found = await this.g(['rev-parse', '--verify', '--quiet', lineRef], { allowFail: true })
    if (found.code !== 0) return null
    return found.stdout.toString('utf8').trim() || null
  }

  // 快照之间按树比对，只有父链接需要 commit 本身。
  async treeOf(commit) {
    const out = await this.g(['rev-parse', commit + '^{tree}'])
    return out.stdout.toString('utf8').trim()
  }

  // 给 tree 在 parentCommits 之上写一个 commit；一条线的第一份快照没有父。
  async commitTree(tree, parentCommits, message) {
    // commit-tree 本身不跑钩子也不签名，但把这两条钉死是有意的：一旦哪天换成 git commit，
    // 仓库里的 gpg 配置或钩子会静默改变快照行为。
    const args = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit-tree', tree]
    for (const parentCommit of parentCommits) args.push('-p', parentCommit)
    args.push('-m', message)
    const out = await this.g(args)
    return out.stdout.toString('utf8').trim()
  }

  find(sessionId, turn) {
    for (let i = this.state.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.state.entries[i]
      if (entry.sessionId === sessionId && entry.turn === turn) return entry
    }
    return null
  }

  // 客户端拿到轮次闭合信号时，宿主的快照可能还没写完。这里让请求挂到写完为止，
  // 而不是让客户端猜时间或反复重试。已经写好的直接返回，不挂。
  wait(sessionId, turn, timeoutMs) {
    const known = this.find(sessionId, turn)
    if (known !== null) return Promise.resolve(known)
    const key = sessionId + '#' + String(turn)
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


  async patch(entry, filePath) {
    const args = ['diff-tree', '-r', '-p', '--no-renames', '--no-color', '-U3', entry.base, entry.tree]
    if (filePath) args.push('--', filePath)
    const result = await this.g(args)
    const text = result.stdout.toString('utf8')
    const limit = 200000
    return text.length > limit
      ? { patch: text.slice(0, limit), truncated: true }
      : { patch: text, truncated: false }
  }



  // 把工作树改写回目标树。绝不整树 checkout：快照故意忽略的文件不能因为不在树里就被删掉。
  async revertTo(targetTree) {
    // 目标树是空的时候，对比出来的每一条都是「删除」，真照做会把整个工作区清空。
    // 这种状态只可能是账本坏了或扫描出错，当成无操作而不是执行。
    const listing = await this.g(['ls-tree', '-r', '--name-only', targetTree], { allowFail: true })
    if (listing.code === 0 && listing.stdout.toString('utf8').trim() === '') {
      return { tree: targetTree, written: 0, removed: 0, empty: true }
    }
    const current = await this.capture()
    const rows = await this.diffTrees(current.tree, targetTree)
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
          // 一个文件删不掉不该让整次还原停下：改成功的照样留在磁盘上，最后一起报出去。
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
    return { tree: current.tree, written, removed: removed.length }
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

  // 还原移动的是工作区，不是时间线：还原后的下一份快照自己决定接到哪条分支。
  // 这里拍的这一份故意不进账本，撤销才有地方可回。
  async revertFiles(entry) {
    const current = await this.capture()
    const saved = await this.commitTree(current.tree, [], 'file-history undo point')
    await this.g(['update-ref', 'refs/undo/point', saved])
    // 撤销点先记好再动磁盘：半路失败时用户还得能按撤销，把已经改掉的退回去。
    this.undo = { commit: saved, sessionId: entry.sessionId, turn: entry.turn, time: Date.now() }
    await this.persistUndo()
    return this.revertTo(entry.base)
  }

  async undoRevert() {
    if (this.undo === null) throw new Error('nothing to undo')
    const result = await this.revertTo(await this.treeOf(this.undo.commit))
    this.undo = null
    await this.persistUndo()
    return result
  }
}

async function detectGit(options) {
  const candidates = []
  if (typeof options.gitPath === 'string' && options.gitPath.trim() !== '') candidates.push(options.gitPath.trim())
  if (process.env.DSH_FILE_HISTORY_GIT) candidates.push(process.env.DSH_FILE_HISTORY_GIT)
  candidates.push('git')
  for (const bin of candidates) {
    const probe = await run(bin, ['--version'], {})
    if (probe.code !== 0) continue
    const version = probe.stdout.toString('utf8').trim()
    const match = /([0-9]+)\.([0-9]+)/.exec(version)
    const major = match ? Number(match[1]) : 0
    const minor = match ? Number(match[2]) : 0
    if (major > 2 || (major === 2 && minor >= 20)) return { ok: true, git: bin, version }
    return { ok: false, reason: 'too-old', version }
  }
  return { ok: false, reason: 'missing', version: '' }
}

class History {
  constructor(ctx, options) {
    this.ctx = ctx
    this.options = options
    this.git = null
    this.workspaces = new Map()
    this.starts = new Map()
    // 轮次开始时扫到的树，键同 starts。turn/end 取走后立刻删，不跨轮残留。
    this.preTrees = new Map()
    this.forks = Object.create(null)
  }

  async gitInfo() {
    if (this.git === null) this.git = await detectGit(this.options)
    return this.git
  }

  async workspace(root) {
    const git = await this.gitInfo()
    if (!git.ok) {
      const error = new Error(git.reason === 'too-old' ? 'git is older than 2.20' : 'git was not found')
      error.code = 'git-unavailable'
      throw error
    }
    const key = keyFor(root)
    let found = this.workspaces.get(key)
    if (found === undefined) {
      // 目录名从 16 位哈希换成了完整哈希：旧目录还在就改名过去，之前的历史不至于在原地丢光。
      const target = path.join(stateRoot(), key)
      const legacy = path.join(stateRoot(), key.slice(0, 16))
      if (!fs.existsSync(target) && fs.existsSync(legacy)) await fsp.rename(legacy, target).catch(() => {})
      found = new Workspace(root, git.git, this.options)
      this.workspaces.set(key, found)
    }
    await found.ensure()
    return found
  }

  // 队列让同一个工作区的 git 调用严格串行。
  // await 返回值的调用者照样看得到失败，队列本身不会因为一次失败就断掉。
  enqueue(workspace, task) {
    const next = workspace.queue.then(task)
    workspace.queue = next.catch(() => {})
    return next
  }

  observe(session, event) {
    if (!session || !event) return
    const header = session.header
    const cwd = header ? header.cwd : undefined
    if (!cwd) return
    const sessionId = session.id
    if (event.type === 'turn/start') {
      const turn = event.data ? event.data.turn : undefined
      if (typeof turn !== 'number') return
      // 记下起始序号用于分叉定位，同时把「模型动手之前」的树存下来。扫描走队列，
      // 保证它排在上一轮的快照之后、模型这一轮的第一次编辑之前。
      this.starts.set(sessionId + '#' + String(turn), event.seq)
      // 排队保证扫描在上一轮快照之后、这一轮第一次编辑之前跑完；存 promise 而不是结果，
      // 是因为轮到 turn/end 时它可能还没扫完，那时应该等它，而不是把它当成没存过。
      const preTree = this.workspace(cwd).then((workspace) =>
        this.enqueue(workspace, () => workspace.startTree())
      )
      this.preTrees.set(sessionId + '#' + String(turn), preTree)
      preTree.catch((error) => {
        const message = error && error.message ? error.message : String(error)
        console.error('[file-history] ' + message)
      })
      return
    }
    if (event.type !== 'turn/end') return
    if (header.origin === 'subagent') return
    const turn = event.data ? event.data.turn : undefined
    if (typeof turn !== 'number') return
    const key = sessionId + '#' + String(turn)
    const startSeq = this.starts.get(key)
    // 存下的是一张还没扫完的盘，不是结果。这里只把它摘下来，等快照真的要用时再去等。
    const preTree = this.preTrees.get(key) || null
    this.starts.delete(key)
    this.preTrees.delete(key)
    this.workspace(cwd)
      .then((workspace) => {
        workspace.lastError = null
        const baseCommit = this.forkOf(workspace, sessionId)
        return this.enqueue(workspace, async () => {
          // 扫描失败就当作没有父树，这一轮按第一轮处理，而不是拿一个 undefined 往下走。
          const tree = preTree === null ? null : await preTree.catch(() => null)
          const startTree = typeof tree === 'string' && tree !== '' ? tree : null
          const familyRoot = this.familyOf(sessionId)
          return workspace.snapshot({ sessionId, familyRoot, endSessionId: sessionId, baseCommit, turn, startSeq, startTree })
        })
      })
      .catch((error) => {
        const message = error && error.message ? error.message : String(error)
        console.error('[file-history] ' + message)
      })
  }

  // 会话的第一轮继承它分叉点解析出的快照，不用维护一张会话表。
  forkOf(workspace, sessionId) {
    const fork = this.forks[String(sessionId)]
    if (!fork) return null
    const boundary = Math.max(0, fork.seq - 1)
    let baseCommit = null
    for (const entry of workspace.state.entries) {
      if (entry.sessionId !== fork.parentSessionId) continue
      if (entry.startSeq > boundary) break
      baseCommit = entry.commit
    }
    return baseCommit
  }

  async sessionWorkspace(sessionId) {
    const session = this.ctx.sessions.get(sessionId)
    const cwd = session && session.header ? session.header.cwd : undefined
    if (!cwd) throw new Error('session has no workspace')
    return this.workspace(cwd)
  }

  async entryOf(sessionId, turn) {
    const workspace = await this.sessionWorkspace(sessionId)
    const entry = workspace.find(sessionId, turn)
    if (entry === null) throw new Error('no snapshot for this turn')
    return { workspace, entry }
  }

  // 会话 id 在 fork 之后是新的，账本要认的却是同一家人：一路往父会话上找，没有父的那个就是族根。
  familyOf(sessionId) {
    let current = String(sessionId)
    for (let depth = 0; depth < 32; depth += 1) {
      const fork = this.forks[current]
      if (fork === undefined) break
      current = String(fork.parentSessionId)
    }
    return current
  }
  // 子会话在存在之前就先记下来，它第一轮才能接上分支点那棵树，尽管账本里那时还只有父会话的行。
  // 分支点也要落成一个检查点：时间线要能点回这里，裁剪轮次时它也不该跟着轮次一起消失。
  async forkBefore(workspace, entry) {
    const seq = Math.max(0, entry.startSeq - 1)
    const child = this.ctx.sessions.fork(entry.sessionId, seq)
    this.forks[String(child.id)] = { parentSessionId: entry.sessionId, seq }
    await this.enqueue(workspace, async () => {
      await workspace.addCheckpoint(child.id, entry.turn, entry.tree, 'fork', this.familyOf(child.id))
      await workspace.persist()
    })
    return child
  }

  async handle(endpoint, payload) {
    const input = payload && typeof payload === 'object' ? payload : {}
    try {
      if (endpoint === 'wait') {
        let workspace
        try {
          workspace = await this.sessionWorkspace(input.sessionId)
        } catch (error) {
          const code = error && error.code === 'git-unavailable' ? 'git-unavailable' : 'no-workspace'
          return { ok: true, value: { entry: null, undo: false, notice: code, baseline: null, baselines: [] } }
        }
        const entry = await workspace.wait(input.sessionId, input.turn, 15000)
        return {
          ok: true,
          value: { entry, undo: workspace.undo !== null, notice: null, baseline: await workspace.latestBaseline() }
        }
      }
      if (endpoint === 'diff') {
        const found = await this.entryOf(input.sessionId, input.turn)
        return { ok: true, value: await found.workspace.patch(found.entry, input.path) }
      }
      if (endpoint === 'revert-files') {
        const found = await this.entryOf(input.sessionId, input.turn)

        const result = await this.enqueue(found.workspace, () => found.workspace.revertFiles(found.entry))
        return { ok: true, value: { written: result.written, removed: result.removed } }
      }
      if (endpoint === 'revert-chat') {
        const found = await this.entryOf(input.sessionId, input.turn)
        const child = await this.forkBefore(found.workspace, found.entry)
        return { ok: true, value: { childSessionId: String(child.id) } }
      }
      if (endpoint === 'revert-both') {
        const found = await this.entryOf(input.sessionId, input.turn)
        const result = await this.enqueue(found.workspace, () => found.workspace.revertFiles(found.entry))
        const child = await this.forkBefore(found.workspace, found.entry)
        return {
          ok: true,
          value: { written: result.written, removed: result.removed, childSessionId: String(child.id) }
        }
      }
      if (endpoint === 'undo-revert') {
        const workspace = await this.sessionWorkspace(input.sessionId)
        const result = await this.enqueue(workspace, () => workspace.undoRevert())
        return { ok: true, value: { written: result.written, removed: result.removed } }
      }
      if (endpoint === 'baseline') {
        const workspace = await this.sessionWorkspace(input.sessionId)
        if (input.action === 'set') {
          const familyRoot = this.familyOf(input.sessionId)
          return { ok: true, value: await this.enqueue(workspace, () => workspace.setBaseline(input.sessionId, input.turn, input.tree, familyRoot)) }
        }
        if (input.action === 'revert') {
          const reverted = await this.enqueue(workspace, () => workspace.revertBaseline(input.tree))
          return { ok: true, value: { written: reverted.written, removed: reverted.removed } }
        }
        return { ok: true, value: await this.enqueue(workspace, () => workspace.baseline()) }
      }
      if (endpoint === 'clear') {
        const workspace = await this.sessionWorkspace(input.sessionId)
        const familyRoot = this.familyOf(input.sessionId)
        const scope = input.scope === 'all' ? 'all' : 'turns'
        const cleared = await this.enqueue(workspace, () => workspace.dropHistory(scope, familyRoot))
        return { ok: true, value: cleared }
      }
      if (endpoint === 'entries') {
        let workspace
        try {
          workspace = await this.sessionWorkspace(input.sessionId)
        } catch (error) {
          const code = error && error.code === 'git-unavailable' ? 'git-unavailable' : 'no-workspace'
          return { ok: true, value: { entries: [], undo: false, notice: code } }
        }
        const own = workspace.state.entries.filter((row) => row.sessionId === input.sessionId)
        const rows = []
        // 老账本里 skipped 记的是 { count, bytes }，现的是数组；发出去的统一是个数。
        const skippedCount = (raw) => (Array.isArray(raw) ? raw.length : raw && typeof raw.count === 'number' ? raw.count : 0)
        // 账本本身最多 100 行，这里不再截断：轮次卡要靠这份清单找到自己那一轮，截断会让老轮次的卡变空。
        for (const entry of own.slice().reverse()) {
          rows.push({
            id: entry.id,
            turn: entry.turn,
            time: entry.time,
            tree: entry.tree,
            changes: entry.changes,
            stats: entry.stats,
            skipped: skippedCount(entry.skipped),
            capped: entry.capped || 0
          })
        }
        // 只读账本。工作树停在哪一格不在这里判断：读取路径不扫盘，时间线的顶部固定是「现在」。
        // 时间线要按时间合并「轮次」和「检查点」，所以检查点跟着列表一起发回去。
        // 检查点不再只有两个，全部发回去；只发这一家的点——同一个工作区里别的会话标的点跟这条线无关。
        const familyRoot = this.familyOf(input.sessionId)
        const baselines = (workspace.state.baselines || []).filter(
          (row) => row.familyRoot === undefined && row.sessionId === undefined ? true : (row.familyRoot || row.sessionId) === familyRoot
        )
        return { ok: true, value: { entries: rows, undo: workspace.undo !== null, notice: null, baseline: baselines[0] || null, baselines } }
      }
      return { ok: false, error: { code: 'unknown-endpoint', message: 'unknown endpoint ' + String(endpoint), details: {} } }
    } catch (error) {
      return {
        ok: false,
        error: { code: 'file-history', message: error && error.message ? error.message : String(error), details: {} }
      }
    }
  }
}

export async function apply(ctx, config) {
  const options = Object.assign({}, DEFAULTS, config && typeof config === 'object' ? config : {})
  if (!Array.isArray(options.excludes)) options.excludes = DEFAULTS.excludes.slice()
  const history = new History(ctx, options)
  ctx.on('session/event', (session, event) => {
    try {
      history.observe(session, event)
    } catch (error) {
      console.error('[file-history] ' + String(error && error.message ? error.message : error))
    }
  })
  ctx.effect(() => {
    const dispose = ctx.connection.rpc.handle(CHANNEL, (endpoint, payload) => history.handle(endpoint, payload))
    return () => {
      Promise.resolve(dispose()).catch(() => {})
    }
  })
}
