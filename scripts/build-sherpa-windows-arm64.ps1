$ErrorActionPreference = 'Stop'

if ($env:PROCESSOR_ARCHITECTURE -notin @('ARM64', 'ARM64EC')) {
  throw "This source build requires a native Windows ARM64 runner; got $env:PROCESSOR_ARCHITECTURE."
}

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pin = Get-Content (Join-Path $root 'native/sherpa-onnx-win-arm64/source.json') -Raw | ConvertFrom-Json
$taskRoot = Join-Path $root "tmp/$($env:GITHUB_RUN_ID ?? 'local')-windows-arm64-sherpa"
if (Test-Path $taskRoot) { throw "Refusing to reuse existing build directory: $taskRoot" }
New-Item -ItemType Directory -Path $taskRoot | Out-Null

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

$sourceDir = Join-Path $taskRoot 'sherpa-onnx'
$buildDir = Join-Path $taskRoot 'build'
$installDir = Join-Path $taskRoot 'install'
Invoke-Checked 'git' @('clone', '--filter=blob:none', '--no-checkout', $pin.repository, $sourceDir)
Invoke-Checked 'git' @('-C', $sourceDir, 'checkout', '--detach', $pin.commit)
$actualCommit = (& git -C $sourceDir rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $pin.commit) { throw 'Sherpa source checkout does not match its pinned commit.' }

$ortCmake = Join-Path $sourceDir 'cmake/onnxruntime-win-arm64.cmake'
$ortText = Get-Content $ortCmake -Raw
if ($ortText -notmatch 'set\(onnxruntime_filename "onnxruntime-win-arm64-\$\{onnxruntime_crt\}-\$\{CMAKE_BUILD_TYPE\}-1\.28\.2\.tar\.bz2"\)') {
  throw 'Pinned sherpa source does not contain the expected ONNX Runtime 1.28.2 artifact name.'
}
$ortHash = [regex]::Match($ortText, 'set\(ONNXRUNTIME_HASH_MD_Release "SHA256=([a-f0-9]{64})"\)').Groups[1].Value
if (-not $ortHash) { throw 'Could not read the ONNX Runtime SHA-256 from the pinned upstream CMake file.' }
Write-Host "Pinned sherpa commit: $actualCommit; ONNX Runtime: $($pin.onnxRuntimeVersion), MD Release SHA-256: $ortHash"

Invoke-Checked 'cmake' @('-S', $sourceDir, '-B', $buildDir, '-A', 'ARM64', "-DCMAKE_INSTALL_PREFIX=$installDir", '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=ON', '-DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF', '-DSHERPA_ONNX_ENABLE_TESTS=OFF', '-DSHERPA_ONNX_USE_STATIC_CRT=OFF', '-DSHERPA_ONNX_ENABLE_C_API=ON')
Invoke-Checked 'cmake' @('--build', $buildDir, '--config', 'Release', '--parallel')
Invoke-Checked 'cmake' @('--install', $buildDir, '--config', 'Release')

$adapterDir = Join-Path $taskRoot 'node-addon-api'
Copy-Item (Join-Path $sourceDir 'scripts/node-addon-api') $adapterDir -Recurse
Copy-Item (Join-Path $root 'scripts/sherpa-arm64-addon-build/package.json') $adapterDir
Copy-Item (Join-Path $root 'scripts/sherpa-arm64-addon-build/package-lock.json') $adapterDir
$adapterCmake = Join-Path $adapterDir 'CMakeLists.txt'
$adapterText = Get-Content $adapterCmake -Raw
$adapterText = $adapterText -replace '(?m)^\s*-Wl,-rpath,\$ENV\{SHERPA_ONNX_INSTALL_DIR\}/lib\s*\r?\n', ''
$adapterText = $adapterText -replace '(?m)^\s*-Wl,-rpath,\$\{SHERPA_ONNX_RPATH_ORIGIN\}\s*\r?\n', ''
Set-Content -Path $adapterCmake -Value $adapterText -NoNewline
$env:SHERPA_ONNX_INSTALL_DIR = $installDir
Push-Location $adapterDir
try {
  Invoke-Checked 'npm' @('ci', '--ignore-scripts', '--no-audit', '--no-fund')
  Invoke-Checked 'npx' @('cmake-js', 'compile', '--runtime', 'electron', '--runtime-version', $pin.electronVersion, '--arch', 'arm64', '--config', 'Release')
} finally { Pop-Location }

$addon = Get-ChildItem $adapterDir -Filter 'sherpa-onnx.node' -File -Recurse | Select-Object -First 1
if (-not $addon) { throw 'The ARM64 Electron Node-API addon was not produced.' }
$packageDir = Join-Path $root 'node_modules/sherpa-onnx-win-arm64'
if (-not (Test-Path $packageDir)) { throw 'The local ARM64 package was not installed by npm ci.' }
Copy-Item $addon.FullName (Join-Path $packageDir 'sherpa-onnx.node') -Force
$dlls = Get-ChildItem $installDir -Filter '*.dll' -File -Recurse
foreach ($name in @('onnxruntime.dll', 'sherpa-onnx-c-api.dll')) {
  $dll = $dlls | Where-Object Name -EQ $name | Select-Object -First 1
  if (-not $dll) { throw "Missing required ARM64 runtime library: $name" }
}
foreach ($dll in ($dlls | Sort-Object FullName | Group-Object Name | ForEach-Object { $_.Group[0] })) {
  Copy-Item $dll.FullName (Join-Path $packageDir $dll.Name) -Force
}
Copy-Item (Join-Path $sourceDir 'LICENSE') (Join-Path $packageDir 'LICENSE.sherpa-onnx') -Force
$ortLicense = Get-ChildItem $buildDir -Filter '*LICENSE*' -File -Recurse | Select-Object -First 1
$ortLicense = Get-ChildItem (Join-Path $buildDir '_deps') -Filter '*LICENSE*' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $ortLicense) { throw 'Could not find the ONNX Runtime license shipped by the pinned upstream source build.' }
Copy-Item $ortLicense.FullName (Join-Path $packageDir 'LICENSE.onnxruntime') -Force
$env:ELECTRON_RUN_AS_NODE = '1'
$electronExe = Join-Path $root 'node_modules/electron/dist/electron.exe'
$electronAbi = (& $electronExe -p 'process.versions.modules').Trim()
if ($LASTEXITCODE -ne 0 -or -not $electronAbi) { throw 'Could not inspect the Electron runtime ABI.' }
@{
  repository = $pin.repository
  tag = $pin.tag
  commit = $actualCommit
  onnxRuntimeVersion = $pin.onnxRuntimeVersion
  onnxRuntimeMdReleaseSha256 = $ortHash
  electronVersion = $pin.electronVersion
  electronAbi = $electronAbi
  targetArch = 'arm64'
} | ConvertTo-Json | Set-Content (Join-Path $packageDir 'BUILD-PROVENANCE.json') -Encoding utf8
Write-Host "Installed sherpa ARM64 addon and required DLLs in $packageDir"
