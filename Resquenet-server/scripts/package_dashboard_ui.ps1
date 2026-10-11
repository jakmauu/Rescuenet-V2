param([string]$OutputZip)

$ErrorActionPreference = 'Stop'
$serverRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$repositoryRoot = Split-Path -Parent $serverRoot
if (-not $OutputZip) {
    $OutputZip = Join-Path $repositoryRoot 'artifacts\rescuenet-dashboard-ui.zip'
}
$archivePath = [System.IO.Path]::GetFullPath($OutputZip)
if (Test-Path -LiteralPath $archivePath) { throw "Paket sudah ada: $archivePath. Gunakan nama OutputZip baru." }
$parentPath = Split-Path -Parent $archivePath
New-Item -ItemType Directory -Path $parentPath -Force | Out-Null

# Exact runtime folders only; production config/database/firmware are excluded.
$runtimeFiles = foreach ($folder in @('templates', 'static')) {
    Get-ChildItem -LiteralPath (Join-Path $serverRoot $folder) -File -Recurse |
        Where-Object { $_.Extension -notin @('.pem', '.key', '.p12', '.pfx', '.crt', '.cer', '.db', '.sqlite', '.sqlite3', '.map') -and $_.Name -notmatch '^\.env' }
}
$guide = Get-Item -LiteralPath (Join-Path $serverRoot 'docs\DASHBOARD_UI_SETUP.md')
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [System.IO.File]::Open($archivePath, [System.IO.FileMode]::CreateNew)
$archive = $null
try {
    $archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
    foreach ($file in @($runtimeFiles) + @($guide)) {
        $relativePath = $file.FullName.Substring($serverRoot.Length + 1).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $relativePath) | Out-Null
    }
} finally {
    if ($archive) { $archive.Dispose() }
    $stream.Dispose()
}
Write-Host "Paket UI: $archivePath"
Write-Host 'Tidak ada backend Python, database, .env, sertifikat atau firmware di paket.'
