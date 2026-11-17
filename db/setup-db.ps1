<#
.SYNOPSIS
  Creates a new database, restores the Saada Hisaab backup into it, and creates
  the read-only login the MCP server uses. Settings come from .env.

.EXAMPLE
  .\db\setup-db.ps1 -BackupPath C:\Users\user\Downloads\sh_db.backup

.EXAMPLE
  # Only (re)apply the read-only login and its permissions:
  .\db\setup-db.ps1 -RolesOnly
#>
param(
  [string]$BackupPath,
  [switch]$RolesOnly,
  [string]$PgBin = "C:\Program Files\PostgreSQL\17\bin"
)
$ErrorActionPreference = "Stop"

# --- Load .env -------------------------------------------------------------
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) { throw ".env not found at $envFile. Copy .env.example to .env and fill it in." }
$cfg = @{}
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') { $cfg[$Matches[1]] = $Matches[2] }
}
foreach ($k in 'PG_HOST', 'PG_PORT', 'DB_NAME', 'PG_ADMIN_USER', 'PG_ADMIN_PASSWORD', 'DB_READONLY_USER', 'DB_READONLY_PASSWORD') {
  if (-not $cfg[$k]) { throw "$k is empty in .env" }
}
if (-not $RolesOnly) {
  if (-not $BackupPath) { throw "Pass -BackupPath <path to sh_db.backup> (or -RolesOnly)." }
  if (-not (Test-Path $BackupPath)) { throw "Backup not found: $BackupPath" }
}

$psql = Join-Path $PgBin "psql.exe"
$createdb = Join-Path $PgBin "createdb.exe"
$pgRestore = Join-Path $PgBin "pg_restore.exe"
$conn = @("-h", $cfg.PG_HOST, "-p", $cfg.PG_PORT, "-U", $cfg.PG_ADMIN_USER, "-w")
$db = $cfg.DB_NAME

$env:PGPASSWORD = $cfg.PG_ADMIN_PASSWORD
try {
  $exists = & $psql @conn -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'"
  if ($LASTEXITCODE -ne 0) { throw "Cannot connect as $($cfg.PG_ADMIN_USER). Check PG_ADMIN_PASSWORD in .env." }

  if (-not $RolesOnly) {
    # Never overwrite an existing database.
    if ($exists -eq "1") { throw "Database '$db' already exists. This script never overwrites; drop it yourself or change DB_NAME in .env." }

    Write-Host "1/3 Creating database '$db'..."
    & $createdb @conn -E UTF8 $db
    if ($LASTEXITCODE -ne 0) { throw "createdb failed." }

    Write-Host "2/3 Restoring $BackupPath (single transaction)..."
    & $pgRestore @conn -d $db --no-owner --no-privileges --single-transaction $BackupPath
    if ($LASTEXITCODE -ne 0) { throw "pg_restore failed; nothing was restored. The empty database '$db' is left in place." }
  }
  elseif ($exists -ne "1") { throw "Database '$db' does not exist yet. Run without -RolesOnly first." }

  Write-Host "3/3 Creating read-only login '$($cfg.DB_READONLY_USER)'..."
  & $psql @conn -d $db -q -v ON_ERROR_STOP=1 `
    -v "ro_user=$($cfg.DB_READONLY_USER)" -v "ro_pw=$($cfg.DB_READONLY_PASSWORD)" -v "db_name=$db" `
    -f (Join-Path $PSScriptRoot "sql\readonly-role.sql")
  if ($LASTEXITCODE -ne 0) { throw "Creating the read-only login failed." }

  Write-Host "Done."
}
finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
