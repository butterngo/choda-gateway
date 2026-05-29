# Registers the native messaging host with Chrome (per-user, HKCU).
# Run AFTER loading the extension, once you know its ID:
#   .\register-host.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop
#
# It (1) generates the (gitignored) host manifest from .template.json with this
# machine's absolute `path` and `allowed_origins`, writing it as UTF-8 without
# BOM (Chrome rejects a BOM), and (2) points the HKCU NativeMessagingHosts key
# at that generated manifest.

param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$templatePath = Join-Path $here "com.ichiba.cookie_host.template.json"
$manifestPath = Join-Path $here "com.ichiba.cookie_host.json"
$batPath = Join-Path $here "run-host.bat"

if (-not (Test-Path $templatePath)) { throw "template not found at $templatePath" }
if (-not (Test-Path $batPath)) { throw "run-host.bat not found at $batPath" }

# Generate the per-machine manifest from the committed template.
$json = Get-Content $templatePath -Raw | ConvertFrom-Json
$json.path = $batPath
$json.allowed_origins = @("chrome-extension://$ExtensionId/")
$out = $json | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($manifestPath, $out)  # .NET default = UTF-8, no BOM

# Point Chrome at the manifest (default value of the host key = manifest path).
$key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.ichiba.cookie_host"
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name "(default)" -Value $manifestPath

Write-Host "Registered native host:" -ForegroundColor Green
Write-Host "  manifest : $manifestPath"
Write-Host "  host     : $batPath"
Write-Host "  origin   : chrome-extension://$ExtensionId/"
Write-Host "Restart Chrome, then log into ichiba to trigger a write."
