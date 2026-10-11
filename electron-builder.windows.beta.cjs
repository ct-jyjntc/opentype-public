const base = require('./electron-builder.windows.cjs')
const { version } = require('./package.json')

if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(version)) {
  throw new Error(`Windows beta config requires a beta version, got ${version}`)
}

module.exports = {
  ...base,
  directories: { ...base.directories, output: `release/testing/${version}` },
  // Keep beta updates on beta.yml. Never generate a stable latest.yml feed.
  detectUpdateChannel: false,
  publish: { ...base.publish, channel: 'beta' },
}
