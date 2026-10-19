<#
.SYNOPSIS
    Build the openGym Android APK from scratch — web bundle, Capacitor sync, Gradle.

.DESCRIPTION
    One command for the whole phone-side build:

        npm ci  ->  npm run build:mobile  ->  gradlew clean assembleDebug

    `build:mobile` used to fail on Windows because it used POSIX inline-env syntax
    (`VITE_MOBILE=1 cmd`). The fork fixes that with `cross-env` in
    frontend/package.json, so no workaround is needed here any more.

    Signing: if `frontend/android/keystore.properties` exists, the APK is signed with
    the shared openGym Wear OS key (see ..\..\keystore\README.md). If it does not, the
    build falls back to the default Android debug key and still succeeds.

.PARAMETER Release
    Build the release variant instead of debug. NOTE: the release build type keeps only
    arm64-v8a/armeabi-v7a native libraries, so a release APK will NOT install on an
    x86_64 emulator.

.PARAMETER SkipNodeModules
    Keep the existing frontend/node_modules instead of re-running `npm ci`.

.PARAMETER SkipClean
    Do not wipe the Gradle build directory first.

.EXAMPLE
    pwsh -File scripts/build-android.ps1
    pwsh -File scripts/build-android.ps1 -Release
#>
[CmdletBinding()]
param(
    [switch]$Release,
    [switch]$SkipNodeModules,
    [switch]$SkipClean
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot     = Split-Path -Parent $PSScriptRoot
$frontendDir  = Join-Path $repoRoot 'frontend'
$androidDir   = Join-Path $frontendDir 'android'
$gradlew      = Join-Path $androidDir 'gradlew.bat'
$variant      = if ($Release) { 'release' } else { 'debug' }

function Write-Step([string]$text) {
    Write-Host ''
    Write-Host "==> $text" -ForegroundColor Cyan
}

function Fail([string]$text) {
    Write-Host "FAILED: $text" -ForegroundColor Red
    exit 1
}

# --- environment -----------------------------------------------------------
# The SDK and JDK are not on PATH in a fresh shell. Gradle needs JAVA_HOME; it finds
# the SDK itself through android/local.properties, which we create if missing.
$env:ANDROID_PREFS_ROOT = $null   # AGP aborts when two Android preference roots are set

if (-not $env:JAVA_HOME -or -not (Test-Path $env:JAVA_HOME)) {
    $candidates = @(
        (Join-Path $env:USERPROFILE '.jdks\jbr-21.0.11'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Android Studio\jbr')
    )
    $env:JAVA_HOME = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $env:JAVA_HOME) { Fail 'JAVA_HOME is not set and no JetBrains/Android Studio JDK was found.' }
Write-Host "JAVA_HOME = $env:JAVA_HOME"

$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME }
       elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT }
       else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not (Test-Path $sdk)) { Fail "Android SDK not found at '$sdk' — set ANDROID_HOME." }
$env:ANDROID_HOME = $sdk
Write-Host "ANDROID_HOME = $sdk"

$localProperties = Join-Path $androidDir 'local.properties'
if (-not (Test-Path $localProperties)) {
    Write-Host "writing $localProperties"
    "sdk.dir=$($sdk -replace '\\','\\')" | Set-Content -Path $localProperties -Encoding ASCII
}

$started = Get-Date

# --- 1. npm ci -------------------------------------------------------------
if (-not $SkipNodeModules) {
    Write-Step "npm ci (frontend)"
    Push-Location $frontendDir
    try {
        npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { Fail 'npm ci' }
    } finally { Pop-Location }
} else {
    Write-Step 'npm ci (skipped)'
}

# --- 2. web bundle + Capacitor sync ---------------------------------------
Write-Step 'npm run build:mobile (VITE_MOBILE bundle -> cap sync into android/)'
Push-Location $frontendDir
try {
    npm run build:mobile
    if ($LASTEXITCODE -ne 0) { Fail 'npm run build:mobile' }
} finally { Pop-Location }

# --- 3. Gradle -------------------------------------------------------------
Write-Step "gradlew assemble$variant"
Push-Location $androidDir
try {
    $assembleTask = 'assemble' + $variant.Substring(0,1).ToUpper() + $variant.Substring(1)
    $tasks = @()
    if (-not $SkipClean) { $tasks += 'clean' }
    $tasks += $assembleTask
    & $gradlew @tasks --no-daemon
    if ($LASTEXITCODE -ne 0) { Fail "gradlew $($tasks -join ' ')" }
} finally { Pop-Location }

# --- 4. report -------------------------------------------------------------
$apkDir = Join-Path $androidDir "app\build\outputs\apk\$variant"
$apks   = Get-ChildItem -Path $apkDir -Filter '*.apk' -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending
if (-not $apks) { Fail "no APK produced in $apkDir" }
$apk = $apks[0]

Write-Step 'APK'
$sizeMb = [math]::Round($apk.Length / 1MB, 1)
Write-Host "path   : $($apk.FullName)"
Write-Host "size   : $($apk.Length) bytes ($sizeMb MB)"
Write-Host "sha256 : $((Get-FileHash $apk.FullName -Algorithm SHA256).Hash)"

$apksigner = Get-ChildItem -Path (Join-Path $sdk 'build-tools') -Directory |
             Sort-Object { [version]$_.Name } -Descending |
             ForEach-Object { Join-Path $_.FullName 'apksigner.bat' } |
             Where-Object { Test-Path $_ } | Select-Object -First 1
if ($apksigner) {
    Write-Host ''
    & $apksigner verify --print-certs $apk.FullName
} else {
    Write-Host 'apksigner not found in build-tools; skipped the certificate check.'
}

Write-Host ''
Write-Host ("done in {0:mm\:ss}" -f ((Get-Date) - $started)) -ForegroundColor Green
