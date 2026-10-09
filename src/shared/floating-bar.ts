export interface FloatingBarSettings {
  placement: 'top' | 'bottom' | 'remember'
  showPreview: boolean
  position?: { displayId: number; x: number; y: number }
}
export function readFloatingBar(value: unknown, strict = false): FloatingBarSettings {
  const data = value && typeof value === 'object' ? value as Record<string, any> : {}
  const placement = ['top', 'bottom', 'remember'].includes(data.placement) ? data.placement : 'bottom'
  const p = data.position
  const valid = p && Number.isFinite(p.displayId) && Number.isFinite(p.x) && Number.isFinite(p.y)
    && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1
  if (strict && ((!['top', 'bottom', 'remember'].includes(data.placement)) || typeof data.showPreview !== 'boolean' || (p !== undefined && !valid))) throw new Error('invalid_config')
  return { placement, showPreview: data.showPreview !== false, ...(valid ? { position: { displayId: p.displayId, x: p.x, y: p.y } } : {}) }
}
