const base = require('./electron-builder.windows.cjs')
const arch = process.env.OPENTYPE_PACKAGE_ARCH
if (!['x64', 'arm64'].includes(arch)) throw new Error('OPENTYPE_PACKAGE_ARCH must be x64 or arm64')
const version = require('./package.json').version
const modelDir = process.env.SENSEVOICE_MODEL_DIR
if (!modelDir) throw new Error('SENSEVOICE_MODEL_DIR must point to the verified release model')
const arm64RuntimeFiles = arch === 'arm64'
  ? [{ from: 'node_modules/sherpa-onnx-win-arm64/vc-runtime', to: '.', filter: ['*.dll', '*.manifest'] }]
  : []
const arm64RuntimeNotices = arch === 'arm64'
  ? [
      { from: 'node_modules/sherpa-onnx-win-arm64/VC-RUNTIME-NOTICE.txt', to: 'licenses/windows-arm64/VC-RUNTIME-NOTICE.txt' },
      { from: 'node_modules/sherpa-onnx-win-arm64/VC-RUNTIME-PROVENANCE.txt', to: 'licenses/windows-arm64/VC-RUNTIME-PROVENANCE.txt' },
    ]
  : []

module.exports = {
  ...base,
  directories: { ...base.directories, output: `release/staging/${version}/windows-${arch}` },
  artifactName: 'OpenType-${version}-Windows-${arch}.${ext}',
  extraFiles: [...(base.extraFiles || []), ...arm64RuntimeFiles],
  extraResources: base.extraResources
    .filter(resource => resource.from !== 'gateway/models/sensevoice-int8')
    .concat(
      [{ from: modelDir, to: 'models/sensevoice-int8', filter: ['model.int8.onnx', 'tokens.txt'] }],
      arm64RuntimeNotices,
    ),
  win: { ...base.win, target: [{ target: 'nsis', arch: [arch] }] },
}
