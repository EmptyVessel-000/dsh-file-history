// dsh-file-history 的宿主侧入口：注册事件与 RPC，其余逻辑分别在 config / workspace / history 里。
// 每个工作区一个账本，影子 git 仓库放在 DSH_HOME 下，用户项目的 .git 一概不碰。
import { SettingsSchema, settingsFrom } from './config.js'
import { History } from './history.js'

export const name = 'dsh-file-history'
export const inject = ['sessions', 'workspaceRegistry', 'connection', 'settings']

const CHANNEL = '/dsh-file-history'
const SETTINGS_NAMESPACE = 'dsh-file-history'

export async function apply(ctx, config) {
  const raw = config && typeof config === 'object' ? config : {}
  const options = settingsFrom(raw)
  // 设置页写的是同一份值：注册成命名空间后，卡片一改就往这个对象里覆盖，
  // 各个工作区在构造时拿的就是这个引用，不必重建。
  const scope = ctx.settings.register(SETTINGS_NAMESPACE, SettingsSchema, { base: options })
  const keys = Object.keys(SettingsSchema.dict)
  const spread = (next) => {
    for (const key of keys) if (next[key] !== undefined) options[key] = next[key]
  }
  spread(scope.get())
  ctx.effect(() => scope.watch((next) => {
    spread(next)
  }))
  const history = new History(ctx, options)
  ctx.on('session/event', (session, event) => {
    try {
      history.observe(session, event)
    } catch (error) {
      console.error('[file-history] ' + String(error && error.message ? error.message : error))
    }
  })
  // 会话销毁时把它留下的起点树与等待者一并丢掉，内存不跟着会话数一直长。
  ctx.on('session/disposed', (session) => {
    if (session && session.id !== undefined) history.release(session.id)
  })
  ctx.effect(() => {
    const dispose = ctx.connection.rpc.handle(CHANNEL, (endpoint, payload) => history.handle(endpoint, payload))
    return () => {
      Promise.resolve(dispose()).catch(() => {})
    }
  })
}
