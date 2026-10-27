$ErrorActionPreference = 'Stop'
try {
    $setup = $env:AMBRA_SOLOIST_DRIVER_SETUP
    $catalog = $env:AMBRA_SOLOIST_DRIVER_CATALOG
    $signature = Get-AuthenticodeSignature -LiteralPath $setup
    if ($signature.Status -ne 'Valid' -or
        $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -ne 'BUREL VINCENT Entrepreneur individuel') {
        throw 'The optional driver installer does not have the expected valid vendor signature.'
    }
    if ((Get-AuthenticodeSignature -LiteralPath $catalog).Status -ne 'Valid') {
        throw 'The Windows driver catalog signature is invalid.'
    }
    Write-Host 'Verified VB-CABLE package. Approve Windows elevation and choose Install Driver in the vendor installer. Reboot afterward.'
    $installer = Start-Process -FilePath $setup -WorkingDirectory (Split-Path -Parent $setup) -Verb RunAs -Wait -PassThru
    if ($installer.ExitCode -notin @(0, 3010)) {
        throw 'The optional driver installer did not complete successfully.'
    }
    exit 0
} catch {
    Write-Error $_
    exit 1
}
