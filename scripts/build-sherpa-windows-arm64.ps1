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

$cmakeArgs = @('-S', $sourceDir, '-B', $buildDir, '-A', 'ARM64', "-DCMAKE_INSTALL_PREFIX=$installDir", '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=ON', '-DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF', '-DSHERPA_ONNX_ENABLE_TESTS=OFF', '-DSHERPA_ONNX_USE_STATIC_CRT=OFF', '-DSHERPA_ONNX_ENABLE_C_API=ON')
Invoke-Checked 'cmake' $cmakeArgs
$cmakeCachePath = Join-Path $buildDir 'CMakeCache.txt'
$generatorInstance = (Select-String -Path $cmakeCachePath -Pattern '^CMAKE_GENERATOR_INSTANCE:INTERNAL=(.+)$').Matches.Groups[1].Value
if (-not $generatorInstance) { throw 'CMake did not identify the selected Visual Studio installation.' }
$redistRoots = @()
if ($env:VCToolsRedistDir -and (Test-Path $env:VCToolsRedistDir)) { $redistRoots += $env:VCToolsRedistDir }
$selectedRedistRoot = Join-Path $generatorInstance 'VC/Redist/MSVC'
if (Test-Path $selectedRedistRoot) { $redistRoots += $selectedRedistRoot }
$crtDirectories = foreach ($redistRoot in ($redistRoots | Select-Object -Unique)) {
  Get-ChildItem $redistRoot -Directory -Recurse -Filter 'Microsoft.VC*.CRT' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '[\\/]arm64[\\/]Microsoft\.VC\d+\.CRT$' }
}
$crtCandidates = foreach ($directory in ($crtDirectories | Sort-Object FullName -Unique)) {
  $runtimeFiles = @(Get-ChildItem $directory.FullName -File | Where-Object { $_.Extension -in @('.dll', '.manifest') })
  $runtimeDlls = @($runtimeFiles | Where-Object Extension -EQ '.dll')
  $requiredNames = @('MSVCP140.dll', 'MSVCP140_1.dll', 'VCRUNTIME140.dll')
  if ($requiredNames | Where-Object { $_ -notin $runtimeDlls.Name }) { continue }
  $versionText = $directory.Parent.Parent.Name
  try { $version = [version]$versionText } catch { continue }
  [pscustomobject]@{ Directory=$directory; Files=$runtimeFiles; Version=$version; VersionText=$versionText }
}
$crtSelection = $crtCandidates | Sort-Object Version -Descending | Select-Object -First 1
if (-not $crtSelection) { throw "The selected Visual Studio installation has no complete ARM64 retail CRT redistributable. Roots: $($redistRoots -join ', ')" }
$crtDirectory = $crtSelection.Directory
$crtRuntimeFiles = $crtSelection.Files
$crtNames = @('MSVCP140.dll', 'MSVCP140_1.dll', 'VCRUNTIME140.dll')
$peMachine = { param($path) $bytes = [IO.File]::ReadAllBytes($path); $offset = [BitConverter]::ToInt32($bytes, 0x3c); if ($bytes[$offset] -ne 0x50 -or $bytes[$offset + 1] -ne 0x45 -or $bytes[$offset + 2] -ne 0 -or $bytes[$offset + 3] -ne 0) { throw "Invalid PE file: $path" }; [BitConverter]::ToUInt16($bytes, $offset + 4) }
foreach ($runtimeFile in $crtRuntimeFiles | Where-Object Extension -EQ '.dll') {
  if ((& $peMachine $runtimeFile.FullName) -ne 0xAA64) { throw "The selected VC redistributable contains a non-ARM64 DLL: $($runtimeFile.FullName)" }
}
$optionalRedistLicense = Get-ChildItem (Split-Path (Split-Path $crtDirectory.FullName -Parent) -Parent) -Filter 'redist.txt' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
$msvcTools = Join-Path $generatorInstance 'VC/Tools/MSVC'
$dumpbin = Get-ChildItem $msvcTools -Filter 'dumpbin.exe' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $dumpbin) { throw "Could not find Microsoft's dumpbin import-table tool under $msvcTools" }
Write-Host "Preflight selected VS=$generatorInstance; app-local ARM64 CRT=$($crtDirectory.FullName) version=$($crtSelection.VersionText); DLLs=$((@($crtRuntimeFiles | Where-Object Extension -EQ '.dll' | ForEach-Object Name)) -join ', '); required imports=$($crtNames -join ', ')"
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
Write-Host "Building sherpa-onnx Node-API addon for Electron $($pin.electronVersion) / arm64 with the MD C++ runtime."
Push-Location $adapterDir
try {
  Invoke-Checked 'npm' @('ci', '--ignore-scripts', '--no-audit', '--no-fund')
  Invoke-Checked 'npx' @('cmake-js', 'compile', '--runtime', 'electron', '--runtime-version', $pin.electronVersion, '--arch', 'arm64', '--config', 'Release', '--CDCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded$<$<CONFIG:Debug>:Debug>DLL')
} finally { Pop-Location }
$cmakeCache = Get-ChildItem $adapterDir -Filter 'CMakeCache.txt' -File -Recurse | Select-Object -First 1
if (-not $cmakeCache) { throw 'cmake-js did not leave a CMake cache to verify its target configuration.' }
$runtimeSetting = Select-String -Path $cmakeCache.FullName -Pattern '^CMAKE_MSVC_RUNTIME_LIBRARY:[^=]+=' | Select-Object -First 1
if (-not $runtimeSetting -or $runtimeSetting.Line -notmatch '^CMAKE_MSVC_RUNTIME_LIBRARY:[^=]+=MultiThreaded.*DLL$') {
  throw 'The Electron addon did not resolve to the dynamic MSVC runtime required by the Sherpa/ONNX MD build.'
}
Write-Host "Resolved addon C++ runtime: $($runtimeSetting.Line)"

$addon = Get-ChildItem $adapterDir -Filter 'sherpa-onnx.node' -File -Recurse | Select-Object -First 1
if (-not $addon) { throw 'The ARM64 Electron Node-API addon was not produced.' }
$packageDir = Join-Path $root 'node_modules/sherpa-onnx-win-arm64'
if (-not (Test-Path $packageDir)) { throw 'The local ARM64 package was not installed by npm ci.' }
$packageItem = Get-Item -LiteralPath $packageDir -Force
if (($packageItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  if ($packageItem.LinkType -notin @('Junction', 'SymbolicLink')) { throw "Refusing to remove an unexpected reparse point: $packageDir ($($packageItem.LinkType))" }
  $expectedSource = (Resolve-Path -LiteralPath (Join-Path $root 'native/sherpa-onnx-win-arm64')).Path.TrimEnd([char[]]@(92, 47))
  $linkTargets = @($packageItem.Target)
  if ($linkTargets.Count -ne 1 -or -not $linkTargets[0]) { throw "Refusing to remove a package link with an unknown target: $packageDir" }
  $targetPath = $linkTargets[0]
  if (-not [IO.Path]::IsPathRooted($targetPath)) { $targetPath = Join-Path (Split-Path $packageDir -Parent) $targetPath }
  $resolvedTarget = (Resolve-Path -LiteralPath $targetPath).Path.TrimEnd([char[]]@(92, 47))
  if (-not [string]::Equals($resolvedTarget, $expectedSource, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove package link outside its expected native source: $resolvedTarget"
  }
  Remove-Item -LiteralPath $packageDir -Force
}
if (-not (Test-Path $packageDir)) {
  New-Item -ItemType Directory -Path $packageDir | Out-Null
  Copy-Item (Join-Path $root 'native/sherpa-onnx-win-arm64/*') $packageDir -Recurse -Force
}
Copy-Item $addon.FullName (Join-Path $packageDir 'sherpa-onnx.node') -Force
$dlls = Get-ChildItem $installDir -Filter '*.dll' -File -Recurse
foreach ($name in @('onnxruntime.dll', 'sherpa-onnx-c-api.dll')) {
  $dll = $dlls | Where-Object Name -EQ $name | Select-Object -First 1
  if (-not $dll) { throw "Missing required ARM64 runtime library: $name" }
}
foreach ($dll in ($dlls | Sort-Object FullName | Group-Object Name | ForEach-Object { $_.Group[0] })) {
  Copy-Item $dll.FullName (Join-Path $packageDir $dll.Name) -Force
}
$nativeClosureFiles = @($addon.FullName) + @($dlls | ForEach-Object FullName) + @($crtRuntimeFiles | Where-Object Extension -EQ '.dll' | ForEach-Object FullName)
$runtimeImports = @()
foreach ($nativeFile in $nativeClosureFiles) {
  $imports = & $dumpbin.FullName /DEPENDENTS $nativeFile 2>&1
  if ($LASTEXITCODE -ne 0) { throw "dumpbin could not inspect native dependency imports: $nativeFile" }
  $names = [regex]::Matches(($imports -join "`n"), '(?im)^\s+([A-Za-z0-9_.-]+\.dll)\s*$') | ForEach-Object { $_.Groups[1].Value }
  $runtimeImports += @($names | Where-Object { $_ -match '^(MSVCP|VCRUNTIME|CONCRT)\d.*\.dll$' })
}
$runtimeImports = @($runtimeImports | Sort-Object -Unique)
$availableRuntimeNames = @($crtRuntimeFiles | Where-Object Extension -EQ '.dll' | ForEach-Object Name)
$missingRuntimeImports = @($runtimeImports | Where-Object { $_ -notin $availableRuntimeNames })
if ($missingRuntimeImports.Count) { throw "The selected ARM64 CRT does not satisfy native imports: $($missingRuntimeImports -join ', ')" }
Write-Host "Native import closure requires app-local VC runtime: $($runtimeImports -join ', ')"
$runtimePackageDir = Join-Path $packageDir 'vc-runtime'
New-Item -ItemType Directory -Path $runtimePackageDir -Force | Out-Null
foreach ($runtimeFile in $crtRuntimeFiles) {
  Copy-Item $runtimeFile.FullName (Join-Path $runtimePackageDir $runtimeFile.Name) -Force
}
$licenseNotice = @(
  'This is a provenance notice, not a license. Microsoft Visual C++ ARM64 runtime files are included unmodified from the selected Visual Studio retail redistributable.'
  "Selected Visual Studio installation: $generatorInstance"
  "Selected redistributable version: $($crtSelection.VersionText)"
  "Selected source directory: $($crtDirectory.FullName)"
  'Consult the applicable Microsoft Software License Terms and the official Visual Studio redistribution list: https://learn.microsoft.com/en-us/visualstudio/releases/2026/redistribution'
  'Runtime deployment guidance: https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files'
)
if ($optionalRedistLicense) {
  Copy-Item $optionalRedistLicense.FullName (Join-Path $runtimePackageDir 'redist.txt') -Force
  $licenseNotice += 'The original Visual Studio redist.txt from this installation is included in vc-runtime/redist.txt.'
}
Set-Content (Join-Path $packageDir 'VC-RUNTIME-NOTICE.txt') -Value $licenseNotice -Encoding utf8
$crtProvenance = @(
  'Source: selected Visual Studio ARM64 retail app-local redistributable installed on the native Windows ARM64 GitHub Actions runner.'
  "Source directory: $($crtDirectory.FullName)"
  "Redistributable version: $($crtSelection.VersionText)"
  'Purpose: satisfy native Sherpa/ONNX dynamic CRT imports without relying on the runner-installed Visual C++ runtime.'
  'Official source/license: https://learn.microsoft.com/en-us/visualstudio/releases/2026/redistribution'
)
foreach ($runtimeFile in $crtRuntimeFiles | Where-Object Extension -EQ '.dll') {
  $hash = (Get-FileHash -Algorithm SHA256 (Join-Path $runtimePackageDir $runtimeFile.Name)).Hash.ToLowerInvariant()
  $crtProvenance += "$($runtimeFile.Name) SHA-256: $hash"
}
Set-Content (Join-Path $packageDir 'VC-RUNTIME-PROVENANCE.txt') -Value $crtProvenance -Encoding utf8
Write-Host "Staged app-local ARM64 VC runtime from $($crtDirectory.FullName) for app-root packaging."
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
