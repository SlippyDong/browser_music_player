$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (Get-Command py -ErrorAction SilentlyContinue) {
    $server = Start-Process -FilePath "py" -ArgumentList "-m", "http.server", "8000" -WorkingDirectory $PSScriptRoot -PassThru
} else {
    $server = Start-Process -FilePath "python" -ArgumentList "-m", "http.server", "8000" -WorkingDirectory $PSScriptRoot -PassThru
}

Start-Sleep -Seconds 2
Start-Process "http://localhost:8000/"
Write-Host "The local server is running as process $($server.Id)."
Write-Host "Use it for initial installation or testing updates, then stop that process when finished."
