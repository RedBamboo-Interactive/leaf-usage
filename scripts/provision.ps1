param(
  [Parameter(Mandatory = $true)]
  [string]$DatabaseId
)

$ErrorActionPreference = "Stop"
$configPath = Join-Path $PSScriptRoot "..\wrangler.toml"
$resolved = (Resolve-Path -LiteralPath $configPath).Path
$content = Get-Content -LiteralPath $resolved -Raw
$content = $content.Replace("REPLACE_WITH_D1_DATABASE_ID", $DatabaseId)
Set-Content -LiteralPath $resolved -Value $content -NoNewline
Write-Host "Configured the D1 database in wrangler.toml"
