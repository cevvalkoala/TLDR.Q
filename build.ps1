param([string]$SevenZipPath = '')

$ErrorActionPreference = 'Stop'
if ($SevenZipPath) {
    $SevenZipPath = (Resolve-Path -LiteralPath $SevenZipPath).Path
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = $PSScriptRoot
$dist = Join-Path $root 'dist'
foreach ($browser in @('firefox', 'chrome')) {
    $target = Join-Path $dist $browser
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Copy-Item -Path (Join-Path $root 'src') -Destination $target -Recurse -Force
    $manifest = if ($browser -eq 'firefox') { 'manifest.json' } else { 'manifest.chrome.json' }
    Copy-Item -Path (Join-Path $root $manifest) -Destination (Join-Path $target 'manifest.json') -Force
    $stream = [System.IO.File]::Open((Join-Path $dist "tldrq-$browser.zip"), [System.IO.FileMode]::Create)
    try {
        $archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
        try {
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $root $manifest), 'manifest.json') | Out-Null
            $source = Join-Path $root 'src'
            foreach ($file in Get-ChildItem -LiteralPath $source -Recurse -File) {
                $name = 'src/' + $file.FullName.Substring($source.Length + 1).Replace('\', '/')
                if ($browser -eq 'firefox' -and $name -eq 'src/worker.js') { continue }
                [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $name) | Out-Null
            }
        } finally {
            $archive.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
    if ($browser -eq 'firefox' -and $SevenZipPath) {
        $optimized = Join-Path $dist ("tldrq-opt-" + [guid]::NewGuid().ToString('N') + '.zip')
        $files = @('manifest.json')
        foreach ($file in Get-ChildItem -LiteralPath (Join-Path $root 'src') -Recurse -File) {
            $name = 'src/' + $file.FullName.Substring((Join-Path $root 'src').Length + 1).Replace('\', '/')
            if ($name -ne 'src/worker.js') { $files += $name }
        }
        try {
            Push-Location -LiteralPath $target
            try {
                & $SevenZipPath a -tzip -mm=Deflate -mx=9 -mfb=258 -mpass=100 -mtc=off -mtm=off -mta=off $optimized @files | Out-Null
                if ($LASTEXITCODE -ne 0) { throw "7-Zip failed with exit code $LASTEXITCODE." }
            } finally {
                Pop-Location
            }
            Move-Item -LiteralPath $optimized -Destination (Join-Path $dist 'tldrq-firefox.zip') -Force
        } finally {
            if (Test-Path -LiteralPath $optimized) { Remove-Item -LiteralPath $optimized -Force }
        }
    }
}
Write-Output "Built unpacked extensions and zip files in $dist"
