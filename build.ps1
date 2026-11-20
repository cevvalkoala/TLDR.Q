$ErrorActionPreference = 'Stop'
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
                [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $name) | Out-Null
            }
        } finally {
            $archive.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}
Write-Output "Built unpacked extensions and zip files in $dist"
