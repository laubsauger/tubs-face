# setup-python.ps1 — Windows equivalent of setup-python.sh
# MLX packages are Apple-Silicon-only; on Windows, Kokoro runs via KPipeline (ONNX/CPU).
#
# PREREQUISITE — espeak-ng (required by Kokoro KPipeline for phonemization):
#   Download the .msi installer from https://github.com/espeak-ng/espeak-ng/releases
#   and run it before starting the server for the first time.

$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectDir = Split-Path -Parent $ScriptDir
$VenvDir    = Join-Path $ProjectDir "venv"
$ReqFile    = Join-Path $ProjectDir "requirements-windows.txt"

# Prefer python3.11 then 3.12 then any python3/python in PATH
$Python = $null
foreach ($candidate in @("python3.11", "python3.12", "python3", "python")) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd) {
        $minor = & $cmd.Source -c "import sys; print(sys.version_info.minor)" 2>$null
        if ($minor -eq "11" -or $minor -eq "12") {
            $Python = $cmd.Source
            break
        }
    }
}

if (-not $Python) {
    Write-Host ""
    Write-Host "============================================================"
    Write-Host "[setup-python] ERROR: Python 3.11 or 3.12 required."
    Write-Host ""
    Write-Host "  Install from: https://www.python.org/downloads/"
    Write-Host "  Or via winget: winget install Python.Python.3.11"
    Write-Host "============================================================"
    Write-Host ""
    exit 1
}

$PyVersion = & $Python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
Write-Host "[setup-python] Using $Python ($PyVersion)"

$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

# If venv exists but was created with a different Python, recreate it
if (Test-Path $VenvPython) {
    $VenvPy = & $VenvPython -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
    if ($VenvPy -ne $PyVersion) {
        Write-Host "[setup-python] Venv has Python $VenvPy but need $PyVersion — recreating..."
        Remove-Item -Recurse -Force $VenvDir
    }
}

# Create venv if missing
if (-not (Test-Path $VenvPython)) {
    Write-Host "[setup-python] Creating venv..."
    & $Python -m venv $VenvDir
}

$VenvPip  = Join-Path $VenvDir "Scripts\pip.exe"
$StampFile = Join-Path $VenvDir ".deps-installed"

# Install/update deps if requirements file is newer than stamp
$needsInstall = $true
if (Test-Path $StampFile) {
    $stampTime = (Get-Item $StampFile).LastWriteTime
    $reqTime   = (Get-Item $ReqFile).LastWriteTime
    if ($reqTime -le $stampTime) {
        $needsInstall = $false
    }
}

if ($needsInstall) {
    Write-Host "[setup-python] Installing Python dependencies..."
    & $VenvPip install --upgrade pip -q
    & $VenvPip install -r $ReqFile
    New-Item -ItemType File -Force $StampFile | Out-Null
} else {
    Write-Host "[setup-python] Python dependencies up to date."
}
