[CmdletBinding()]
param(
  [string]$Message = 'deploy(web): publish latest web app',
  [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Command
  )

  Write-Host "`n==> $Name" -ForegroundColor Cyan
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed (exit code $LASTEXITCODE)."
  }
}

if (-not $SkipChecks) {
  Invoke-Step 'Lint' { npm run lint }
  Invoke-Step 'Type check' { npm run typecheck }
  Invoke-Step 'Unit tests' { npm run test --workspace @recoder/web -- --testTimeout=30000 }
  Invoke-Step 'GitHub Pages build' { npm run build:pages }
}

$changes = @(git status --porcelain)
if ($changes.Count -eq 0) {
  Write-Host 'No changes to publish.' -ForegroundColor Yellow
  exit 0
}

Invoke-Step 'Stage changes' { git add --all }
Invoke-Step 'Check staged diff' { git diff --cached --check }
Invoke-Step 'Create commit' { git commit -m $Message }
Invoke-Step 'Push main to GitHub' { git push origin main }

Write-Host "`nPublished. GitHub Actions will now verify and deploy GitHub Pages." -ForegroundColor Green
