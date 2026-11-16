$ErrorActionPreference = 'Stop'
$secret = Read-Host 'Buffer API key (hidden; never paste into chat)' -AsSecureString
$handle = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
  $env:BUFFER_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($handle)
  npm run probe -- @args
  if ($LASTEXITCODE -ne 0) { throw 'Probe failed; see sanitized status above.' }
} finally {
  Remove-Item Env:BUFFER_API_KEY -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($handle)
  $secret.Dispose()
}
