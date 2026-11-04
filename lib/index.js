// dsh-file-history 的宿主侧入口：注册事件与 RPC，其余逻辑分别在 config / workspace / history 里。
// 每个工作区一个账本，影子 git 仓库放在 DSH_HOME 下，用户项目的 .git 一概不碰。
import { Config, settingsFrom } from './config.js'
import { History } from './history.js'

export const name = 'dsh-file-history'
export const inject = ['sessions', 'workspaceRegistry', 'connection', 'settings']
export { Config }

const CHANNEL = '/dsh-file-history'

export async function apply(ctx, config) {
  const raw = config && typeof config === 'object' ? config : {}
  const options = settingsFrom(raw)
  // 设置页由插件自己的卡片画，关掉自动生成的通用表单，免得同一份配置出现两次。
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber))
  // 标了 volatile 的字段由加载器原地写回 raw，插件不重启；把新值抄进同一份 options，
  // 各工作区拿的就是这个引用，下一轮读到的就是新值。
  ctx.on('loader/volatile-update', () => {
    Object.assign(options, settingsFrom(raw))
  })
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
