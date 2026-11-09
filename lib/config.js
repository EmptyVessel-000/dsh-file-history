// 默认值、设置 schema、账本路径。
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

// 3：账本分三层，树层放配置、会话层放数据。版本号对不上的账本直接作废重来，不写迁移。
export const LEDGER_VERSION = 3

export const DEFAULTS = {
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
  // 新会话树默认每轮拍一次；关掉就只在手动设检查点时记录。树层可以在侧栏里单独改。
  auto: true,
  maxFileBytes: 5 * 1024 * 1024,
  // 自带 .git 的目录要按文件展开，但先数一遍再决定：超过这条线就整块不认，指针留着不动。
  maxRepoFiles: 20000,
  maxEntries: 100,
  // 自动裁剪的切点取倒数第几个检查点：2 就是最近两个点里较早的那个。
  pruneAfterCheckpoints: 2,
  // 检查点不够这么多时按最近多少轮裁；不设这一条，账本只能一直涨到 maxEntries 才动手。
  keepRecentTurns: 20,
  // 规模失控时只降级记录，不碰磁盘：单个目录的文件数超过这条线，这个目录就整块不进快照。
  maxDirFiles: 20000,
  // 整个工作区加起来的字节数上限，超了从最大的文件开始让位，直到回到预算内。
  maxBytes: 2 * 1024 * 1024 * 1024,
  // 留空表示在 PATH 里找；填了就用这一个。设置页不展示。
  gitPath: ''
}

// 0.1.7 起设置表单由 cordis Config 自动生成，命名空间就是加载器条目 id（cordis.patch.yml 里的 file-history），
// 所以这份 schema 必须叫 Config 并导出。标了 volatile 的字段才是改完立刻生效的那几个。
export const Config = z.object({
  auto: z.boolean().default(true).volatile(),
  turnCard: z.boolean().default(true).volatile(),
  dock: z.boolean().default(true).volatile(),
  timeline: z.boolean().default(true).volatile(),
  keepRecentTurns: z.number().min(0).max(1000).default(DEFAULTS.keepRecentTurns).volatile(),
  maxFileBytes: z.number().min(0).max(1024 * 1024 * 1024).default(DEFAULTS.maxFileBytes).volatile(),
  maxRepoFiles: z.number().min(0).max(1000000).default(DEFAULTS.maxRepoFiles).volatile(),
  maxBytes: z.number().min(0).max(1024 * 1024 * 1024 * 1024).default(DEFAULTS.maxBytes).volatile(),
  pruneAfterCheckpoints: z.number().min(0).max(100).default(DEFAULTS.pruneAfterCheckpoints).volatile(),
  // 下面这几项只在 cordis.patch.yml 里配，设置页不展示；写进 schema 是为了让老配置继续通过校验。
  excludes: z.array(z.string()).default(DEFAULTS.excludes),
  maxEntries: z.number().min(0).max(100000).default(DEFAULTS.maxEntries),
  maxDirFiles: z.number().min(0).max(1000000).default(DEFAULTS.maxDirFiles),
  gitPath: z.string().default('')
})

// 加载器交给插件的那份配置里，标了 volatile 的数字字段会变成空对象；这里只认真实类型的值，
// 其余一律落回默认值，免得把对象拿去当数字算。
export function settingsFrom(raw) {
  const out = Object.assign({}, DEFAULTS)
  if (raw === null || typeof raw !== 'object') return out
  for (const key of Object.keys(DEFAULTS)) {
    const base = DEFAULTS[key]
    const value = raw[key]
    if (Array.isArray(base)) {
      if (Array.isArray(value)) out[key] = value.slice()
    } else if (typeof base === 'boolean') {
      if (typeof value === 'boolean') out[key] = value
    } else if (typeof base === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    } else if (typeof base === 'string' && typeof value === 'string') {
      out[key] = value
    }
  }
  return out
}

export function stateRoot() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-file-history')
}

// 同一个目录只认一个账本：路径大小写在不同来源里写法不一，统一按小写算。
export function keyFor(root) {
  return createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex')
}
