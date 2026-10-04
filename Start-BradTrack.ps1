param(
    [int]$Port = 8765
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDirectory = Join-Path $root '.data'
$legacyDataFile = Join-Path $dataDirectory 'portfolio.json'
$portfolioDirectory = Join-Path $dataDirectory 'portfolios'
$portfolioIndexFile = Join-Path $dataDirectory 'portfolios.json'
$listener = New-Object System.Net.HttpListener
$prefix = "http://127.0.0.1:$Port/"

New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $portfolioDirectory -Force | Out-Null
if (-not (Test-Path $portfolioIndexFile)) {
    $defaultId = 'default'
    $defaultDirectory = Join-Path $portfolioDirectory $defaultId
    New-Item -ItemType Directory -Path $defaultDirectory -Force | Out-Null
    $defaultDataFile = Join-Path $defaultDirectory 'portfolio.json'
    if (Test-Path $legacyDataFile) {
        $legacyBody = [System.IO.File]::ReadAllText($legacyDataFile)
        $legacyData = ConvertFrom-Json -InputObject $legacyBody
        $legacyProperties = @($legacyData.PSObject.Properties.Name)
        if (@('transactions', 'quotes', 'history' | Where-Object { $legacyProperties -notcontains $_ }).Count -gt 0) {
            throw 'Legacy portfolio data is invalid; it has not been changed.'
        }
        [System.IO.File]::WriteAllText($defaultDataFile, $legacyBody, (New-Object System.Text.UTF8Encoding -ArgumentList $false))
    }
    else {
        [System.IO.File]::WriteAllText($defaultDataFile, '{"transactions":[],"quotes":{},"history":{},"settings":{"target":0}}', (New-Object System.Text.UTF8Encoding -ArgumentList $false))
    }

    $legacyImportsDirectory = Join-Path $dataDirectory 'imports'
    foreach ($category in @('transactions', 'history')) {
        $legacyCategoryDirectory = Join-Path $legacyImportsDirectory $category
        if (Test-Path $legacyCategoryDirectory) {
            $destination = Join-Path (Join-Path $legacyImportsDirectory $defaultId) $category
            New-Item -ItemType Directory -Path $destination -Force | Out-Null
            Get-ChildItem -Path $legacyCategoryDirectory -File -ErrorAction SilentlyContinue | Copy-Item -Destination $destination -Force
        }
    }

    $index = @{ portfolios = @(@{ id = $defaultId; alias = 'Mi cartera' }) }
    $indexJson = $index | ConvertTo-Json -Depth 5 -Compress
    [System.IO.File]::WriteAllText($portfolioIndexFile, $indexJson, (New-Object System.Text.UTF8Encoding -ArgumentList $false))
}

$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Host "BradTrack disponible en $prefix"
Write-Host 'Solo escucha en este equipo. Pulsa Ctrl+C para detenerlo.'

function Write-Response($Response, [int]$StatusCode, [string]$ContentType, [byte[]]$Bytes) {
    $Response.StatusCode = $StatusCode
    $Response.ContentType = $ContentType
    $Response.Headers['X-Content-Type-Options'] = 'nosniff'
    $Response.Headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    $Response.ContentLength64 = $Bytes.Length
    $Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
    $Response.Close()
}

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        $path = $request.Url.AbsolutePath

        try {
            if ($path -eq '/api/portfolios' -and $request.HttpMethod -eq 'GET') {
                Write-Response $response 200 'application/json; charset=utf-8' ([System.IO.File]::ReadAllBytes($portfolioIndexFile))
                continue
            }

            if ($path -eq '/api/portfolios' -and $request.HttpMethod -eq 'POST') {
                $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
                $body = $reader.ReadToEnd()
                $reader.Dispose()
                $newPortfolio = ConvertFrom-Json -InputObject $body
                $alias = ([string]$newPortfolio.alias).Trim()
                if ($alias.Length -lt 1 -or $alias.Length -gt 48) { throw 'Portfolio alias must contain 1 to 48 characters.' }
                $index = Get-Content -Path $portfolioIndexFile -Raw | ConvertFrom-Json
                if (@($index.portfolios | Where-Object { [string]::Equals([string]$_.alias, $alias, [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) {
                    Write-Response $response 409 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('That portfolio alias already exists.'))
                    continue
                }
                $portfolioId = 'p-' + [guid]::NewGuid().ToString('N')
                $newDirectory = Join-Path $portfolioDirectory $portfolioId
                New-Item -ItemType Directory -Path $newDirectory -Force | Out-Null
                $newDataFile = Join-Path $newDirectory 'portfolio.json'
                [System.IO.File]::WriteAllText($newDataFile, '{"transactions":[],"quotes":{},"history":{},"settings":{"target":100000}}', (New-Object System.Text.UTF8Encoding -ArgumentList $false))
                $index.portfolios = @($index.portfolios) + @([pscustomobject]@{ id = $portfolioId; alias = $alias })
                $temporaryIndexFile = "$portfolioIndexFile.tmp"
                [System.IO.File]::WriteAllText($temporaryIndexFile, ($index | ConvertTo-Json -Depth 8 -Compress), (New-Object System.Text.UTF8Encoding -ArgumentList $false))
                Move-Item -Path $temporaryIndexFile -Destination $portfolioIndexFile -Force
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((@{ id = $portfolioId; alias = $alias } | ConvertTo-Json -Compress))
                Write-Response $response 201 'application/json; charset=utf-8' $bytes
                continue
            }

            $portfolioRoute = [regex]::Match($path, '^/api/portfolios/([A-Za-z0-9-]+)/(data|imports)$')
            if ($portfolioRoute.Success) {
                $portfolioId = $portfolioRoute.Groups[1].Value
                $action = $portfolioRoute.Groups[2].Value
                $index = Get-Content -Path $portfolioIndexFile -Raw | ConvertFrom-Json
                $record = @($index.portfolios | Where-Object { $_.id -eq $portfolioId }) | Select-Object -First 1
                if ($null -eq $record) {
                    Write-Response $response 404 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('Portfolio not found'))
                    continue
                }

                $portfolioDataFile = Join-Path (Join-Path $portfolioDirectory $portfolioId) 'portfolio.json'
                if ($action -eq 'data' -and $request.HttpMethod -eq 'GET') {
                    Write-Response $response 200 'application/json; charset=utf-8' ([System.IO.File]::ReadAllBytes($portfolioDataFile))
                    continue
                }

                if ($action -eq 'data' -and $request.HttpMethod -eq 'POST') {
                    $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
                    $body = $reader.ReadToEnd()
                    $reader.Dispose()
                    $parsed = ConvertFrom-Json -InputObject $body
                    $propertyNames = @($parsed.PSObject.Properties.Name)
                    if (@('transactions', 'quotes', 'history' | Where-Object { $propertyNames -notcontains $_ }).Count -gt 0) {
                        throw 'Invalid portfolio data.'
                    }
                    $temporaryFile = "$portfolioDataFile.tmp"
                    [System.IO.File]::WriteAllText($temporaryFile, $body, (New-Object System.Text.UTF8Encoding -ArgumentList $false))
                    Move-Item -Path $temporaryFile -Destination $portfolioDataFile -Force
                    Write-Response $response 200 'application/json; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('{"ok":true}'))
                    continue
                }

                if ($action -eq 'imports' -and $request.HttpMethod -eq 'POST') {
                    if ($request.ContentLength64 -gt 15728640) {
                        Write-Response $response 413 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('CSV too large'))
                        continue
                    }
                    $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
                    $body = $reader.ReadToEnd()
                    $reader.Dispose()
                    $import = ConvertFrom-Json -InputObject $body
                    $importProperties = @($import.PSObject.Properties.Name)
                    if ($importProperties -notcontains 'name' -or $importProperties -notcontains 'category' -or $importProperties -notcontains 'content') {
                        throw 'Invalid CSV import.'
                    }
                    if ([System.IO.Path]::GetExtension([string]$import.name) -ine '.csv' -or [string]::IsNullOrWhiteSpace([string]$import.content)) {
                        throw 'A non-empty CSV file is required.'
                    }
                    $category = switch ([string]$import.category) {
                        'transactions' { 'transactions' }
                        'history' { 'history' }
                        default { throw 'Invalid CSV category.' }
                    }
                    $safeName = [System.IO.Path]::GetFileNameWithoutExtension([string]$import.name) -replace '[^A-Za-z0-9._-]', '_'
                    if ([string]::IsNullOrWhiteSpace($safeName)) { $safeName = 'import' }
                    $importsDirectory = Join-Path (Join-Path (Join-Path $dataDirectory 'imports') $portfolioId) $category
                    New-Item -ItemType Directory -Path $importsDirectory -Force | Out-Null
                    $fileName = "$(Get-Date -Format 'yyyyMMdd-HHmmss-fff')-$safeName-$([guid]::NewGuid().ToString('N').Substring(0, 8)).csv"
                    $importPath = Join-Path $importsDirectory $fileName
                    [System.IO.File]::WriteAllText($importPath, [string]$import.content, (New-Object System.Text.UTF8Encoding -ArgumentList $false))
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes((@{ saved = $true; file = "imports/$portfolioId/$category/$fileName" } | ConvertTo-Json -Compress))
                    Write-Response $response 200 'application/json; charset=utf-8' $bytes
                    continue
                }
            }

            if ($request.HttpMethod -ne 'GET') {
                Write-Response $response 405 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('Method not allowed'))
                continue
            }

            $file = switch ($path) {
                '/' { Join-Path $root 'index.html' }
                '/app.js' { Join-Path $root 'app.js' }
                '/styles.css' { Join-Path $root 'styles.css' }
                default { $null }
            }
            if ($null -eq $file -or -not (Test-Path $file)) {
                Write-Response $response 404 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('Not found'))
                continue
            }

            $contentType = if ($file.EndsWith('.html')) { 'text/html; charset=utf-8' } elseif ($file.EndsWith('.js')) { 'text/javascript; charset=utf-8' } else { 'text/css; charset=utf-8' }
            Write-Response $response 200 $contentType ([System.IO.File]::ReadAllBytes($file))
        }
        catch {
            $message = [System.Text.Encoding]::UTF8.GetBytes('Request could not be processed.')
            Write-Response $response 400 'text/plain; charset=utf-8' $message
            Write-Warning $_.Exception.Message
        }
    }
}
finally {
    $listener.Stop()
    $listener.Close()
}