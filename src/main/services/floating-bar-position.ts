import { screen, type BrowserWindow, type Rectangle } from 'electron'
import type { FloatingBarSettings } from '../../shared/floating-bar'

/** Window positions are desktop coordinates; offsets are normalized inside each work area. */
export class FloatingBarPositioner {
  private displayId?: number
  private expected?: Rectangle
  private expanded = false
  private moveTimer?: ReturnType<typeof setTimeout>
  constructor(private window: BrowserWindow, private settings: () => FloatingBarSettings,
    private save: (settings: FloatingBarSettings) => void) {
    window.on('moved', this.moved)
    screen.on('display-added', this.layout)
    screen.on('display-removed', this.layout)
    screen.on('display-metrics-changed', this.layout)
    this.begin()
  }
  begin(target?: Rectangle) {
    const usable = target && [target.x,target.y,target.width,target.height].every(Number.isFinite) && target.width > 0 && target.height > 0
    this.displayId = usable ? screen.getDisplayMatching(target).id : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id
    this.expanded = false; this.layout()
  }
  preview(visible: boolean) {
    if (visible === this.expanded) return
    this.expanded = visible; this.layout()
  }
  refresh() { this.layout() }
  private layout = () => {
    if (this.window.isDestroyed()) return
    const prefs = this.settings(), displays = screen.getAllDisplays()
    const preferred = prefs.placement === 'remember' ? prefs.position?.displayId : this.displayId
    const display = displays.find(d => d.id === preferred) ?? displays.find(d => d.id === this.displayId)
      ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const area = display.workArea, width = Math.min(360, area.width), height = Math.min(this.expanded ? 224 : 104, area.height)
    const margin = 20
    let x = area.x + (area.width - width) / 2
    let y = prefs.placement === 'top' ? area.y + margin : area.y + area.height - height - margin
    if (prefs.placement === 'remember' && prefs.position) {
      x = area.x + prefs.position.x * Math.max(0, area.width - width)
      y = area.y + prefs.position.y * Math.max(0, area.height - height)
    }
    this.expected = { x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width))),
      y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))), width, height }
    this.window.setBounds(this.expected)
  }
  private moved = () => {
    clearTimeout(this.moveTimer)
    this.moveTimer = setTimeout(() => {
      if (this.window.isDestroyed()) return
      const bounds = this.window.getBounds()
      if (this.expected?.x === bounds.x && this.expected?.y === bounds.y) return
      const display = screen.getDisplayMatching(bounds), area = display.workArea
      this.displayId = display.id; this.expected = bounds
      this.save({ ...this.settings(), placement: 'remember', position: { displayId: display.id,
        x: Math.max(0, Math.min(1, (bounds.x - area.x) / Math.max(1, area.width - bounds.width))),
        y: Math.max(0, Math.min(1, (bounds.y - area.y) / Math.max(1, area.height - bounds.height))) } })
    }, 150)
  }
  dispose() {
    clearTimeout(this.moveTimer)
    this.window.removeListener('moved', this.moved)
    screen.removeListener('display-added', this.layout)
    screen.removeListener('display-removed', this.layout)
    screen.removeListener('display-metrics-changed', this.layout)
  }
}
