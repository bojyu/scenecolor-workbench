Set-StrictMode -Version Latest
$ErrorActionPreference = 'SilentlyContinue'

$PageUrl = 'http://localhost:5173/'
$Deadline = (Get-Date).AddSeconds(90)

while ((Get-Date) -lt $Deadline) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $PageUrl -TimeoutSec 2
        if ($response.StatusCode -eq 200) {
            $info = [System.Diagnostics.ProcessStartInfo]::new()
            $info.FileName = $PageUrl
            $info.UseShellExecute = $true
            [System.Diagnostics.Process]::Start($info) | Out-Null
            exit 0
        }
    }
    catch {
    }

    Start-Sleep -Milliseconds 500
}

exit 1
