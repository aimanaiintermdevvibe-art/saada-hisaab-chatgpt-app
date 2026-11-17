<#
.SYNOPSIS
  Restores the Saada Hisaab backup into a PostgreSQL database and creates the read-only login
  the MCP server uses. Works for local PostgreSQL and for Supabase; settings come from an env file.

.EXAMPLE
  # Local PostgreSQL (settings in .env): creates DB_NAME if it does not exist.
  .\db\setup-db.ps1 -BackupPath C:\Users\user\Downloads\sh_db.backup

.EXAMPLE
  # Supabase (settings in .env.supabase): restores into the project's existing, empty "postgres" database.
  .\db\setup-db.ps1 -EnvFile .env.supabase -BackupPath C:\Users\user\Downloads\sh_db.backup

.EXAMPLE
  # Only (re)apply the read-only login and its permissions:
  .\db\setup-db.ps1 -RolesOnly
#>
param(
  [string]$BackupPath,
  [string]$EnvFile = ".env",
  [switch]$RolesOnly,
  [string]$PgBin = "C:\Program Files\PostgreSQL\17\bin"
)
$ErrorActionPreference = "Stop"

# --- Load settings ---------------------------------------------------------
$root = Split-Path -Parent $PSScriptRoot
$envPath = if ([System.IO.Path]::IsPathRooted($EnvFile)) { $EnvFile } else { Join-Path $root $EnvFile }
if (-not (Test-Path $envPath)) { throw "$EnvFile not found at $envPath." }
$cfg = @{}
foreach ($line in Get-Content $envPath) {
  if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') { $cfg[$Matches[1]] = $Matches[2] }
}
foreach ($k in 'PG_HOST', 'PG_PORT', 'DB_NAME', 'PG_ADMIN_USER', 'PG_ADMIN_PASSWORD', 'DB_READONLY_USER', 'DB_READONLY_PASSWORD') {
  if (-not $cfg[$k] -or $cfg[$k] -match '^<.*>$') { throw "$k is not set in $EnvFile" }
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

# Supabase's connection pooler expects "<role>.<project-ref>" as the user name; the role itself is "<role>".
$roleName = $cfg.DB_READONLY_USER.Split(".")[0]

# Same SSL behaviour as the server (PG_SSL).
switch ($cfg.PG_SSL) {
  "require" { $env:PGSSLMODE = "require" }
  "verify" { $env:PGSSLMODE = "verify-full"; $env:PGSSLROOTCERT = $cfg.PG_SSL_CA_FILE }
  default { $env:PGSSLMODE = "prefer" }
}

$env:PGPASSWORD = $cfg.PG_ADMIN_PASSWORD
try {
  $version = & $psql @conn -d postgres -tAc "SHOW server_version"
  if ($LASTEXITCODE -ne 0) { throw "Cannot connect to $($cfg.PG_HOST) as $($cfg.PG_ADMIN_USER). Check the host, user and PG_ADMIN_PASSWORD in $EnvFile." }
  Write-Host "Connected to PostgreSQL $version at $($cfg.PG_HOST)"
  $exists = & $psql @conn -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'"

  if (-not $RolesOnly) {
    if ($exists -ne "1") {
      Write-Host "1/3 Creating database '$db'..."
      & $createdb @conn -E UTF8 $db
      if ($LASTEXITCODE -ne 0) { throw "createdb failed." }
    }
    else {
      # Never overwrite data: an existing database must have no tables yet (e.g. a new Supabase project).
      $tables = & $psql @conn -d $db -tAc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"
      if ([int]$tables -gt 0) { throw "Database '$db' already has $tables tables in schema public. This script never overwrites data." }
      Write-Host "1/3 Database '$db' exists and is empty; restoring into it."
    }

    Write-Host "2/3 Restoring $BackupPath (single transaction)..."
    & $pgRestore @conn -d $db --no-owner --no-privileges --single-transaction $BackupPath
    if ($LASTEXITCODE -ne 0) { throw "pg_restore failed; nothing was restored." }
  }
  elseif ($exists -ne "1") { throw "Database '$db' does not exist yet. Run without -RolesOnly first." }

  Write-Host "3/3 Creating read-only login '$roleName'..."
  & $psql @conn -d $db -q -v ON_ERROR_STOP=1 `
    -v "ro_user=$roleName" -v "ro_pw=$($cfg.DB_READONLY_PASSWORD)" -v "db_name=$db" `
    -f (Join-Path $PSScriptRoot "sql\readonly-role.sql")
  if ($LASTEXITCODE -ne 0) { throw "Creating the read-only login failed." }

  Write-Host "Done."
}
finally {
  Remove-Item Env:PGPASSWORD, Env:PGSSLMODE, Env:PGSSLROOTCERT -ErrorAction SilentlyContinue
}
