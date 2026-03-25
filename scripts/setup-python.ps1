# setup-python.ps1 - Windows equivalent of setup-python.sh
# MLX packages are Apple-Silicon-only; on Windows, Kokoro runs via KPipeline (ONNX/CPU).
#
# PREREQUISITE - espeak-ng (required by Kokoro KPipeline for phonemization):
#   Download the .msi installer from https://github.com/espeak-ng/espeak-ng/releases
#   and run it before starting the server for the first time.

$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectDir = Split-Path -Parent $ScriptDir
$VenvDir    = Join-Path $ProjectDir "venv"
$ReqFile    = Join-Path $ProjectDir "requirements-windows.txt"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$VenvPip    = Join-Path $VenvDir "Scripts\pip.exe"
$StampFile  = Join-Path $VenvDir ".deps-installed"

$OldEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"

# 1. If user already created a venv, trust it and skip global search!
$HasValidVenv = $false
if (Test-Path $VenvPython) {
    try {
        $minor = & $VenvPython -c "import sys; print(sys.version_info.minor)" 2>&1
        $minorStr = "$minor".Trim()
        if ($minorStr -eq "11" -or $minorStr -eq "12") {
            Write-Host "[setup-python] Found existing venv with Python 3.$minorStr - skipping global discovery."
            $HasValidVenv = $true
        } else {
            Write-Host "[setup-python] Venv has Python 3.$minorStr but need 3.11/3.12 - recreating..."
            Remove-Item -Recurse -Force $VenvDir
        }
    } catch {}
}

# 2. If no valid venv, find a global Python to create it
if (-not $HasValidVenv) {
    $GlobalPython = $null
    
    # Check "py" (Windows Python Launcher) first, then specific versions
    foreach ($candidate in @("py", "python3.11", "python3.12", "python3", "python")) {
        $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($cmd) {
            try {
                if ($candidate -eq "py") {
                    $minor = & $cmd.Source -3 -c "import sys; print(sys.version_info.minor)" 2>&1
                } else {
                    $minor = & $cmd.Source -c "import sys; print(sys.version_info.minor)" 2>&1
                }
                $minorStr = "$minor".Trim()
                
                if ($minorStr -eq "11" -or $minorStr -eq "12") {
                    $GlobalPython = $cmd.Source
                    $IsPyLauncher = ($candidate -eq "py")
                    break
                }
            } catch { }
        }
    }

    if (-not $GlobalPython) {
        Write-Host ""
        Write-Host "============================================================"
        Write-Host "[setup-python] ERROR: Python 3.11 or 3.12 required."
        Write-Host ""
        Write-Host "  Could not find a valid global Python or an existing venv."
        Write-Host "  You can create the venv yourself manually:"
        Write-Host "    py -3.11 -m venv venv   (or python -m venv venv)"
        Write-Host "  Then run 'npm install' again."
        Write-Host "============================================================"
        Write-Host ""
        exit 1
    }

    Write-Host "[setup-python] Creating venv using $GlobalPython..."
    if ($IsPyLauncher) {
        # The Windows launcher uses -3 to force standard Python 3.x
        & $GlobalPython -3 -m venv $VenvDir
    } else {
        & $GlobalPython -m venv $VenvDir
    }
}

# 3. Dependencies
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
    if ($LASTEXITCODE -eq 0) {
        New-Item -ItemType File -Force $StampFile | Out-Null
    } else {
        Write-Host "[setup-python] WARNING: Pip install failed with exit code $LASTEXITCODE."
        exit 1
    }
} else {
    Write-Host "[setup-python] Python dependencies up to date."
}

$ErrorActionPreference = $OldEAP
