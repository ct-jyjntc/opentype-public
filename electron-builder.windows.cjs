const base = require('./electron-builder.json')
module.exports = {
  ...base,
  artifactName: 'OpenType-${version}-Windows-${arch}.${ext}',
  protocols: [{ name: 'OpenType', schemes: ['opentype'] }],
  extraResources: [
    { from: 'native/windows/build/OpenTypeNative.dll', to: 'lib/windows/build/OpenTypeNative.dll' },
    { from: 'native/windows/build/OutputAudio.exe', to: 'lib/windows/build/OutputAudio.exe' },
    { from: 'native/windows/build/ClipboardGuard.exe', to: 'lib/windows/build/ClipboardGuard.exe' },
    { from: 'gateway/models/sensevoice-int8', to: 'models/sensevoice-int8', filter: ['model.int8.onnx', 'tokens.txt'] },
  ],
  win: { target: [{ target: 'nsis', arch: ['x64'] }], requestedExecutionLevel: 'asInvoker' },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true, createStartMenuShortcut: true, deleteAppDataOnUninstall: false },
}
