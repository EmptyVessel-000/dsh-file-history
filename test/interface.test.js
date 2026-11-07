// 端点驱动一遍：宿主侧的五个入口在这里真跑一次 git 与账本，客户端调的名对不上会当场断。
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { History } from '../lib/history.js'
import { DEFAULTS } from '../lib/config.js'

function harness(header) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-int-'))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fh-home-'))
  process.env.DSH_HOME = home
  execFileSync('git', ['init', '-q'], { cwd: root })
  const live = { id: 'line-1', header: { id: 'line-1', cwd: root }, snapshotEvents: () => [] }
  const ctx = {
    sessions: { get: (id) => (String(id) === 'line-1' ? live : undefined) },
    workspaceRegistry: { readSessionHeader: async () => (header === undefined ? { cwd: root } : header) },
    on: () => () => {}
  }
  const history = new History(ctx, Object.assign({}, DEFAULTS))
  const cleanup = async () => {
    await fsp.rm(root, { recursive: true, force: true })
    await fsp.rm(home, { recursive: true, force: true })
  }
  return { history, root, cleanup }
}

// 两轮：第一轮只留锚点（没有可比的起点），第二轮才有记录。
async function twoTurns(history, root) {
  const file = path.join(root, 'alpha.txt')
  await fsp.writeFile(file, 'one\n')
  const workspace = await history.workspace(root)
  await workspace.snapshot({ sessionId: 'line-1', turn: 1, startSeq: 1, endSeq: 2 })
  await fsp.writeFile(file, 'two\n')
  const entry = await workspace.snapshot({ sessionId: 'line-1', turn: 2, startSeq: 3, endSeq: 4 })
  return { workspace, entry, file }
}

test('state 从空账本起步，快照落账后按轮次读出来', async () => {
  const { history, root, cleanup } = harness()
  try {
    const empty = await history.handle('state', { sessionId: 'line-1' })
    assert.equal(empty.ok, true)
    assert.deepEqual(empty.value.entries, [])
    const { entry } = await twoTurns(history, root)
    assert.equal(entry.turn, 2)
    const state = await history.handle('state', { sessionId: 'line-1' })
    assert.equal(state.value.entries.length, 1)
    assert.equal(state.value.entries[0].turn, 2)
    assert.equal(state.value.entries[0].changes.length, 1)
    // 起点那个点：会话开始时的样子，不算轮次。
    assert.equal(state.value.baselines.length, 1)
    assert.equal(state.value.baselines[0].source, 'origin')
    assert.equal(state.value.diff, null)
  } finally {
    await cleanup()
  }
})

test('设检查点换掉这一轮，删掉后还原成快照', async () => {
  const { history, root, cleanup } = harness()
  try {
    const { entry } = await twoTurns(history, root)
    const set = await history.handle('point', { sessionId: 'line-1', action: 'set', tree: entry.tree, turn: 2, seq: 4 })
    assert.equal(set.ok, true)
    assert.equal(set.value.replaced, true)
    const afterSet = await history.handle('state', { sessionId: 'line-1' })
    assert.equal(afterSet.value.entries.length, 0)
    assert.equal(afterSet.value.baselines.length, 2)
    const dropped = await history.handle('point', { sessionId: 'line-1', action: 'delete', tree: entry.tree })
    assert.equal(dropped.ok, true)
    assert.equal(dropped.value.removed, 1)
    const afterDrop = await history.handle('state', { sessionId: 'line-1' })
    assert.equal(afterDrop.value.entries.length, 1)
    assert.equal(afterDrop.value.baselines.length, 1)
  } finally {
    await cleanup()
  }
})

test('还原文件写回那一版，撤销退到这一轮开始前', async () => {
  const { history, root, cleanup } = harness()
  try {
    const { file } = await twoTurns(history, root)
    await fsp.writeFile(file, 'three\n')
    const back = await history.handle('restore', { sessionId: 'line-1', turn: 2, mode: 'files' })
    assert.equal(back.ok, true)
    assert.equal(fs.readFileSync(file, 'utf8'), 'two\n')
    const undo = await history.handle('restore', { sessionId: 'line-1', turn: 2, mode: 'undo' })
    assert.equal(undo.ok, true)
    assert.equal(fs.readFileSync(file, 'utf8'), 'one\n')
  } finally {
    await cleanup()
  }
})

test('清除轮次留下起点，账本回到只有一个点', async () => {
  const { history, root, cleanup } = harness()
  try {
    await twoTurns(history, root)
    const cleared = await history.handle('clear', { sessionId: 'line-1', scope: 'turns' })
    assert.equal(cleared.ok, true)
    assert.equal(cleared.value.removed, 1)
    const state = await history.handle('state', { sessionId: 'line-1' })
    assert.deepEqual(state.value.entries, [])
    assert.equal(state.value.baselines.length, 1)
  } finally {
    await cleanup()
  }
})

test('settings 改这棵树的开关与规则，落到账本', async () => {
  const { history, root, cleanup } = harness()
  try {
    const value = await history.handle('config', { sessionId: 'line-1', off: true, keep: 7, rules: 'a/\nb, c', allow: '/src, ./lib' })
    assert.equal(value.ok, true)
    assert.equal(value.value.off, true)
    assert.equal(value.value.keep, 7)
    assert.deepEqual(value.value.excludes, ['a/', 'b', 'c'])
    assert.deepEqual(value.value.allow, ['src', 'lib'])
    const state = await history.handle('state', { sessionId: 'line-1' })
    assert.equal(state.value.off, true)
    assert.equal(state.value.auto, true)
  } finally {
    await cleanup()
  }
})

test('找不到会话头时 entries 给 null 并把原因带出去', async () => {
  const { history, cleanup } = harness({})
  try {
    const state = await history.handle('state', { sessionId: 'line-1' })
    assert.equal(state.ok, true)
    assert.equal(state.value.entries, null)
    assert.match(state.value.notice, /cwd/)
  } finally {
    await cleanup()
  }
})

test('端点报错原样带出，别折成一句笼统的话', async () => {
  const { history, root, cleanup } = harness()
  try {
    await history.handle('state', { sessionId: 'line-1' })
    const missing = await history.handle('point', { sessionId: 'line-1', action: 'delete' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'no-tree')
    const unknown = await history.handle('nope', {})
    assert.equal(unknown.error.code, 'unknown-endpoint')
    // 没记录的一轮谈不上撤销：报错要说清是「这一轮没有可退的记录」
    const undo = await history.handle('restore', { sessionId: 'line-1', turn: 9, mode: 'undo' })
    assert.equal(undo.ok, false)
    assert.match(undo.error.message, /可退/)
  } finally {
    await cleanup()
  }
})


// 六轮，每轮改一次同一个文件；检查点跟着它那一轮设，跟真实用法一致。
async function sixTurns(history, root) {
  const file = path.join(root, 'beta.txt')
  await fsp.writeFile(file, '0\n')
  const workspace = await history.workspace(root)
  await workspace.snapshot({ sessionId: 'line-1', turn: 1, startSeq: 1, endSeq: 2 })
  for (let turn = 2; turn <= 6; turn += 1) {
    await fsp.writeFile(file, String(turn) + '\n')
    const entry = await workspace.snapshot({ sessionId: 'line-1', turn, startSeq: turn * 2 - 1, endSeq: turn * 2 })
    if (turn === 2 || turn === 4) await workspace.addCheckpoint('line-1', turn, entry.tree, 'manual', turn * 2)
  }
  await workspace.persist()
  return workspace
}

test('两道上限同时生效：轮次窗口与检查点窗口都满足才留下', async () => {
  const { history, root, cleanup } = harness()
  try {
    const workspace = await sixTurns(history, root)
    await history.handle('config', { sessionId: 'line-1', keep: 1, prune: 2 })
    await workspace.maintain()
    // 最近 1 轮是第六轮，它也在倒数第二个检查点之后：留下来；
    // 第三到第五轮虽然不算旧，但早于切点，一并删掉。
    const tight = await history.handle('state', { sessionId: 'line-1' })
    assert.deepEqual(tight.value.entries.map((one) => one.turn), [6])
  } finally {
    await cleanup()
  }
})

test('轮次窗口设 0 就只按检查点那条线裁', async () => {
  const { history, root, cleanup } = harness()
  try {
    const workspace = await sixTurns(history, root)
    await history.handle('config', { sessionId: 'line-1', keep: 0 })
    await workspace.maintain()
    // 倒数第二个检查点在第二轮上：第三轮往后的都留着，更早的清掉。
    const loose = await history.handle('state', { sessionId: 'line-1' })
    // 列表按时间倒序下发。
    assert.deepEqual(loose.value.entries.map((one) => one.turn), [6, 5, 4, 3])
  } finally {
    await cleanup()
  }
})
