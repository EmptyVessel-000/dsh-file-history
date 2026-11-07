// git 输出的解析与合并规则。
// 单独放一个文件不是为了分层，是因为这几段最容易改错、也最容易单独验：
// 喂一段真实的 git 输出，看出来的东西对不对，不需要仓库也不需要工作区。

// diff-tree --raw -z 输出成对的 "<header>\0<path>\0"，header 形如 ":mode mode sha sha status"。
export function parseRaw(buffer) {
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

// diff-tree --numstat -z 是 "<add>\t<del>\t<path>\0"；二进制文件的两个数字是 "-"。
export function parseNumstat(buffer) {
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

// ls-files -s -z 每行是 "<mode> <sha> <stage>\t<path>\0"。mode 要留着：160000 是子模块指针。
export function parseLsFiles(buffer) {
  const rows = []
  for (const part of buffer.toString('utf8').split('\u0000')) {
    if (!part) continue
    const tab = part.indexOf('\t')
    if (tab < 0) continue
    const fields = part.slice(0, tab).split(' ')
    rows.push({ mode: fields[0], sha: fields[1], path: part.slice(tab + 1) })
  }
  return rows
}

// cat-file --batch-check 回一行 "<sha> <type> <size>"。
export function parseSizes(buffer) {
  const map = new Map()
  for (const line of buffer.toString('utf8').split('\n')) {
    const fields = line.split(' ')
    if (fields.length >= 3 && fields[1] === 'blob') map.set(fields[0], Number(fields[2]))
  }
  return map
}

// --batch 在这行之后紧跟 <size> 字节原文和一个换行，取内容时两者都要跳过。
export function parseBatchBlobs(buffer) {
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

export function summarize(changes) {
  const stats = { files: changes.length, additions: 0, deletions: 0, binary: 0 }
  for (const change of changes) {
    stats.additions += change.additions
    stats.deletions += change.deletions
    if (change.binary) stats.binary += 1
  }
  return stats
}

// 子模块指针和它里面的文件之间来回切换不是真的改动：指针时代那些内容从来没被记过。
// 一份清单里同一条路径既是文件又是目录前缀，只可能是这种切换，整片跳过，别刷出几百个「新增」。
export function foldPointers(rows) {
  const paths = new Set(rows.map((row) => row.path))
  const folded = new Set()
  for (const row of rows) {
    let at = row.path
    while (true) {
      const cut = at.lastIndexOf('/')
      if (cut < 0) break
      at = at.slice(0, cut)
      if (paths.has(at)) folded.add(at)
    }
  }
  if (folded.size === 0) return rows
  return rows.filter((row) => {
    for (const prefix of folded) {
      if (row.path === prefix || row.path.startsWith(prefix + '/')) return false
    }
    return true
  })
}
