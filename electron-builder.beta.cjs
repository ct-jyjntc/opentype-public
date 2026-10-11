const base = require('./electron-builder.json')
const { version } = require('./package.json')
if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(version)) {
  throw new Error(`macOS beta config requires a beta version, got ${version}`)
}
// CFBundleShortVersionString must be numeric: 0.2.1-beta.3 → 0.2.1.
const bundleVersion = version.split('-')[0]
const { signAsync } = require('@electron/osx-sign')

module.exports = {
  ...base,
  directories: { ...base.directories, output: `release/testing/${version}` },
  artifactName: 'OpenType-${version}-macOS-${arch}.${ext}',
  buildVersion: bundleVersion,
  // Keep beta updates on beta-mac.yml. Never generate a stable latest-mac.yml feed.
  detectUpdateChannel: false,
  publish: { ...base.publish, channel: 'beta' },
  mac: {
    ...base.mac,
    minimumSystemVersion: '13.0',
    bundleShortVersion: bundleVersion,
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
