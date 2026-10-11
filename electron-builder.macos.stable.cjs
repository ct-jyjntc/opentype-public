const base = require('./electron-builder.json')
const { version } = require('./package.json')
const arch = process.env.OPENTYPE_MACOS_ARCH

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`stable macOS config requires a stable version, got ${version}`)
}
if (!['x64', 'arm64'].includes(arch)) {
  throw new Error('OPENTYPE_MACOS_ARCH must be x64 or arm64')
}

const slug = arch === 'x64' ? 'x64' : 'arm64'

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    output: `release/staging/${version}/macos-${slug}`
  },
  artifactName: 'OpenType-${version}-macOS-${arch}.${ext}',
  buildVersion: version,
  detectUpdateChannel: false,
  mac: {
    ...base.mac,
    minimumSystemVersion: '13.0',
    target: [
      { target: 'dmg', arch: [arch] },
      { target: 'zip', arch: [arch] }
    ],
    // The current host has no Developer ID certificate or notarization credentials.
    // This enables build and local runtime review with an ad-hoc signature only.
    sign: options => require('@electron/osx-sign').signAsync({
      ...options,
      identity: '-',
      identityValidation: false,
      preAutoEntitlements: false,
      optionsForFile: file => ({ ...options.optionsForFile(file), timestamp: 'none' })
    })
  },
  dmg: { title: `OpenType ${version}`, sign: false },
  extraResources: [
    ...base.extraResources,
    { from: 'gateway/models/sensevoice-int8', to: 'models/sensevoice-int8', filter: ['model.int8.onnx', 'tokens.txt'] }
  ]
}
