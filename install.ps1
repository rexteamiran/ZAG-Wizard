$ErrorActionPreference = "Stop"

# PS 5.1 may not negotiate TLS 1.2 with github.com by default.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Binary = "wizard.exe"
$InstallDir = "zagrooo-wizard"
$Arch = if ([Environment]::Is64BitOperatingSystem) { "amd64" } else { "386" }

if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64" -or $env:PROCESSOR_ARCHITEW6432 -eq "ARM64") {
    $Arch = "arm64"
}

$Archive = "ZAG-Wizard-windows-$Arch.zip"
$ArchiveUrl = "https://github.com/rexteamiran/ZAG-Wizard/releases/latest/download/$Archive"
$WorkerUrl = "https://github.com/rexteamiran/ZAG-Panel/releases/latest/download/worker.js"
$LatestVersion = (Invoke-RestMethod -Uri "https://raw.githubusercontent.com/rexteamiran/ZAG-Wizard/main/VERSION" -UseBasicParsing).Trim()

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$BinaryPath = Join-Path $InstallDir $Binary
$NeedsInstall = $false

if (Test-Path $BinaryPath) {
    $InstalledVersion = (& $BinaryPath --version).Trim()
    Write-Host "Installed version: $InstalledVersion"
    Write-Host "Latest version: $LatestVersion"

    if ($InstalledVersion -eq $LatestVersion) {
        Write-Host "Wizard is up to date."
    } else {
        Write-Host "Updating to version $LatestVersion..."
        $NeedsInstall = $true
    }
} else {
    Write-Host "Wizard not found here. Installing version $LatestVersion..."
    $NeedsInstall = $true
}

if ($NeedsInstall) {
    Write-Host "Downloading $Archive..."

    $zipPath = Join-Path $InstallDir $Archive
    Invoke-WebRequest -Uri $ArchiveUrl -OutFile $zipPath -UseBasicParsing
    Expand-Archive -Path $zipPath -DestinationPath $InstallDir -Force
    Remove-Item $zipPath
}

Write-Host "Downloading worker.js..."
Invoke-WebRequest -Uri $WorkerUrl -OutFile (Join-Path $InstallDir "worker.js") -UseBasicParsing

$env:LAUNCHED_BY_SCRIPT = "1"

Push-Location $InstallDir
try {
    & ".\$Binary"
} finally {
    Pop-Location
}