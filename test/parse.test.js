import assert from 'node:assert/strict'
import test from 'node:test'
import { foldPointers, parseBatchBlobs, parseLsFiles, parseNumstat, parseRaw, parseSizes, summarize } from '../lib/parse.js'

// 造一段和 git 真实输出同形的 buffer：git 用 \0 分隔，这里也照做。
const z = (parts) => Buffer.from(parts.join('\u0000'), 'utf8')

test('ls-files 保留 mode，路径里的空格不截断', () => {
  const buffer = z(['100644 aaaa 0	src/a b.js', '160000 bbbb 0	proj', ''])
  assert.deepEqual(parseLsFiles(buffer), [
    { mode: '100644', sha: 'aaaa', path: 'src/a b.js' },
    { mode: '160000', sha: 'bbbb', path: 'proj' }
  ])
})

test('raw 输出成对取，状态缺省算修改', () => {
  const buffer = z([':100644 100644 aaaa bbbb M', 'src/a.js', ':000000 160000 0000 cccc A', 'proj', ''])
  assert.deepEqual(parseRaw(buffer), [
    { status: 'M', newSha: 'bbbb', path: 'src/a.js' },
    { status: 'A', newSha: 'cccc', path: 'proj' }
  ])
})

test('改名多带一条源路径，连读两段', () => {
  const buffer = z([':100644 100644 aaaa bbbb R100', 'src/old.js', 'src/new.js', ':100644 100644 cccc dddd M', 'src/a.js', ''])
  assert.deepEqual(parseRaw(buffer), [
    { status: 'R', newSha: 'bbbb', from: 'src/old.js', path: 'src/new.js' },
    { status: 'M', newSha: 'dddd', path: 'src/a.js' }
  ])
})

test('numstat 的改名把路径放在后面两段，按新路径计数', () => {
  const map = parseNumstat(z(['4\t2\t', 'src/old.js', 'src/new.js', '1\t0\tsrc/a.js', '']))
  assert.deepEqual(map.get('src/new.js'), { additions: 4, deletions: 2, binary: false })
  assert.deepEqual(map.get('src/a.js'), { additions: 1, deletions: 0, binary: false })
  assert.equal(map.has('src/old.js'), false)
})

test('numstat 里的 - 表示二进制，不做减法', () => {
  const map = parseNumstat(z(['3\t1\tsrc/a.js', '-\t-\timg/logo.png', '']))
  assert.deepEqual(map.get('src/a.js'), { additions: 3, deletions: 1, binary: false })
  assert.deepEqual(map.get('img/logo.png'), { additions: 0, deletions: 0, binary: true })
})

test('batch-check 只认 blob', () => {
  const map = parseSizes(Buffer.from('aaaa blob 10\nbbbb tree 3\ncccc blob 245\n', 'utf8'))
  assert.equal(map.get('aaaa'), 10)
  assert.equal(map.get('cccc'), 245)
  assert.equal(map.has('bbbb'), false)
})

test('batch 取内容时跳过 size 后面的换行，内容里的换行不算边界', () => {
  const body = Buffer.from('one\ntwo', 'utf8')
  const buffer = Buffer.concat([Buffer.from('aaaa blob 7\n', 'utf8'), body, Buffer.from('\nbbbb blob 2\nok\n', 'utf8')])
  const map = parseBatchBlobs(buffer)
  assert.equal(map.get('aaaa').toString('utf8'), 'one\ntwo')
  assert.equal(map.get('bbbb').toString('utf8'), 'ok')
})

test('指针和它里面的文件同时出现时整片跳过', () => {
  const rows = [
    { path: 'proj' },
    { path: 'proj/src/a.js' },
    { path: 'proj/README.md' },
    { path: 'other/x.js' }
  ]
  assert.deepEqual(foldPointers(rows), [{ path: 'other/x.js' }])
})

test('没有指针时一份都不动', () => {
  const rows = [{ path: 'a.js' }, { path: 'src/b.js' }]
  assert.equal(foldPointers(rows), rows)
})

test('前缀相同但不是同一条路径，不算指针', () => {
  const rows = [{ path: 'proj' }, { path: 'project/a.js' }]
  assert.equal(foldPointers(rows).length, 2)
})

test('汇总按条数、增删行、二进制分别计数', () => {
  const stats = summarize([
    { additions: 2, deletions: 1, binary: false },
    { additions: 0, deletions: 0, binary: true }
  ])
  assert.deepEqual(stats, { files: 2, additions: 2, deletions: 1, binary: 1 })
})
