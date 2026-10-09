const base = require('./electron-builder.json')
const { version } = require('./package.json')
const { signAsync } = require('@electron/osx-sign')

module.exports = {
  ...base,
  directories: { ...base.directories, output: `release/testing/${version}` },
  artifactName: 'OpenType-${version}-macOS-${arch}.${ext}',
  buildVersion: '0.2.0',
  mac: {
    ...base.mac,
    minimumSystemVersion: '13.0',
    bundleShortVersion: '0.2.0',
    // Explicitly re-sign the generated bundle; skipping signing leaves stale Electron seals.
    sign: options => signAsync({ ...options, identity: '-', identityValidation: false, preAutoEntitlements: false,
      optionsForFile: file => ({ ...options.optionsForFile(file), timestamp: 'none' }) })
  },
  dmg: { title: `OpenType ${version}`, sign: false },
  extraResources: [
    ...base.extraResources,
    { from: 'gateway/models/sensevoice-int8', to: 'models/sensevoice-int8', filter: ['model.int8.onnx', 'tokens.txt'] }
  ]
}
