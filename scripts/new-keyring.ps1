param([string]$Destination = './secrets/encryption-keys.json')
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Destination) { throw 'Keyring already exists. Never overwrite it; see rotation instructions.' }
$directory = Split-Path -Parent $Destination
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $directory /inheritance:r /grant:r "${identity}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict secret-directory ACL. Correct this before storing credentials.' }
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$json = @{ v1 = [Convert]::ToBase64String($bytes) } | ConvertTo-Json -Compress
[IO.File]::WriteAllText([IO.Path]::GetFullPath($Destination), $json, (New-Object Text.UTF8Encoding($false)))
Write-Host 'Keyring created with a restricted secret-directory ACL. Back it up separately from PostgreSQL.'
