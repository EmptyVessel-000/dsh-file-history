// git 进程调用：唯一的逃生口是超时，一次卡住的 git 会把整个工作区的队列永远堵死。
import { spawn } from 'node:child_process'

export function run(bin, args, options) {
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
    const limit = opts.timeoutMs || 120000
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: -1, stdout: Buffer.concat(out), stderr: Buffer.from('git ' + String(args[0]) + ' 超过 ' + String(limit) + 'ms 没有返回') })
    }, limit)
    timer.unref()
    child.on('error', (error) => {
      resolve({ code: -1, stdout: Buffer.concat(out), stderr: Buffer.from(String(error && error.message)) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code === null ? -1 : code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) })
    })
    // git 提前退出（报错、用法不对）时管子里没人收数据，写进去会以 EPIPE 冒成未捕获异常。
    child.stdin.on('error', () => {})
    if (opts.input === undefined || opts.input === null) child.stdin.end()
    else child.stdin.end(opts.input)
  })
}

// 第一个候选太老不代表机器上没有新的：记下来接着试，全试完再下结论。
export async function detectGit(options) {
  const candidates = []
  if (typeof options.gitPath === 'string' && options.gitPath.trim() !== '') candidates.push(options.gitPath.trim())
  if (process.env.DSH_FILE_HISTORY_GIT) candidates.push(process.env.DSH_FILE_HISTORY_GIT)
  candidates.push('git')
  let tooOld = ''
  for (const bin of candidates) {
    const probe = await run(bin, ['--version'], {})
    if (probe.code !== 0) continue
    const version = probe.stdout.toString('utf8').trim()
    const match = /([0-9]+)\.([0-9]+)/.exec(version)
    const major = match ? Number(match[1]) : 0
    const minor = match ? Number(match[2]) : 0
    if (major > 2 || (major === 2 && minor >= 20)) return { ok: true, git: bin, version }
    if (tooOld === '') tooOld = version
  }
  if (tooOld !== '') return { ok: false, reason: 'too-old', version: tooOld }
  return { ok: false, reason: 'missing', version: '' }
}
