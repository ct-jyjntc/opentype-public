// 用户设置存储。
//
// 渲染层用点路径写入（update_settings 的 params 是扁平键值：
// 'translation_settings.target_languages'、'user_info.locale'、
// 'personal_auto_style_on'），读取时则要嵌套对象（get_user_info 回
// translation_settings，get_dictation_settings 回 dictation_settings）。
// 因此服务端整体存 JSON，写入时按点路径展开合并，不逐字段建模。

import { getDb } from '../db/index.ts'

export function getUserSettings(userId: string): Record<string, unknown> {
  const db = getDb()
  const row = db.prepare('SELECT settings FROM user_settings WHERE user_id = ?').get(userId) as
    | { settings: string } | undefined
  if (!row) return {}
  try {
    const parsed = JSON.parse(row.settings)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function saveUserSettings(userId: string, settings: Record<string, unknown>): void {
  const db = getDb()
  db.prepare(
    'INSERT INTO user_settings (user_id, settings, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at'
  ).run(userId, JSON.stringify(settings), Date.now())
}

/** 按点路径写入嵌套对象。非对象的中间节点被覆盖。 */
function setDotted(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let node = target
  for (const part of parts.slice(0, -1)) {
    const next = node[part]
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      node[part] = {}
    }
    node = node[part] as Record<string, unknown>
  }
  node[parts[parts.length - 1]] = value
}

/** 合并 update_settings 的扁平点路径参数，返回合并后的完整设置。 */
export function mergeUserSettings(userId: string, patch: Record<string, unknown>): Record<string, unknown> {
  const settings = getUserSettings(userId)
  for (const [key, value] of Object.entries(patch)) {
    if (!key || key === '__proto__' || key.includes('__proto__')) continue
    setDotted(settings, key, value)
  }
  saveUserSettings(userId, settings)
  return settings
}

/** 读取嵌套路径，缺省返回 undefined。 */
export function getPath(settings: Record<string, unknown>, path: string): unknown {
  let node: unknown = settings
  for (const part of path.split('.')) {
    if (!node || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}
