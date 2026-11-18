$ErrorActionPreference='Stop'
$fingerprintRoot=Split-Path $PSScriptRoot -Parent
$fingerprintGo=(Get-Command go -ErrorAction SilentlyContinue).Source
if(!$fingerprintGo){$fingerprintGo=Join-Path (Split-Path $fingerprintRoot -Parent) 'artifacts\fingerprint-adaptation-20261020\toolchain\go\bin\go.exe'}
Push-Location (Join-Path $fingerprintRoot 'fingerprint-engine')
try{& $fingerprintGo build -trimpath -o (Join-Path $fingerprintRoot 'vendor\fingerprint\fingerprint-engine.exe') .;if($LASTEXITCODE -ne 0){throw 'Fingerprint engine build failed'}}finally{Pop-Location}
