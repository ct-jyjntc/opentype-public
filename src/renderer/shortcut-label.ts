/** Storage keeps shared modifier names; labels name the user's physical keys. */
export function shortcutLabel(shortcut: string): string {
  if (!shortcut) return '未设置'
  const windows = window.opentype.platform === 'win32'
  const names: Record<string, string> = {
    leftctrl: '左 Ctrl', leftcontrol: '左 Ctrl', rightctrl: '右 Ctrl', rightcontrol: '右 Ctrl',
    leftshift: '左 Shift', rightshift: '右 Shift',
    leftalt: windows ? '左 Alt' : '左 Option', leftoption: windows ? '左 Alt' : '左 Option',
    rightalt: windows ? '右 Alt' : '右 Option', rightoption: windows ? '右 Alt' : '右 Option',
    leftcmd: windows ? '左 Win' : '左 Command', leftcommand: windows ? '左 Win' : '左 Command',
    rightcmd: windows ? '右 Win' : '右 Command', rightcommand: windows ? '右 Win' : '右 Command',
    command: windows ? 'Win' : 'Command', cmd: windows ? 'Win' : 'Command',
    option: windows ? 'Alt' : 'Option', control: 'Ctrl',
  }
  return shortcut.split('+').map(key => names[key.toLowerCase()] ?? key).join(' + ')
}
