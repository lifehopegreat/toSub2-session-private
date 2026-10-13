$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
if (!$env:TOSUB2_PYTHON) {
    $env:TOSUB2_PYTHON = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
}
if (!(Test-Path -LiteralPath $env:TOSUB2_PYTHON)) {
    throw 'Project Python environment is missing. Follow the setup steps in the deployment document.'
}
$localPlaywright = Join-Path $PSScriptRoot 'node_modules\playwright\index.mjs'
if (!$env:TOSUB2_PLAYWRIGHT_MODULE -and (Test-Path -LiteralPath $localPlaywright)) {
    $env:TOSUB2_PLAYWRIGHT_MODULE = $localPlaywright
}
$env:ONBOARDING_OUTPUT_ROOT = Join-Path $PSScriptRoot 'tmp\chatgpt-onboarding-console'
Push-Location -LiteralPath $PSScriptRoot
try {
    & $node (Join-Path $PSScriptRoot 'src\console-server.mjs') --host 127.0.0.1 --port 4399
    if ($LASTEXITCODE -ne 0) { throw "toSub2 exited with code $LASTEXITCODE" }
} finally {
    Pop-Location
}
