param(
    [ValidateRange(1, 65535)][int]$Port = 8765
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDirectory = Join-Path $root '.data'
$legacyDataFile = Join-Path $dataDirectory 'portfolio.json'
$portfolioDirectory = Join-Path $dataDirectory 'portfolios'
$portfolioIndexFile = Join-Path $dataDirectory 'portfolios.json'
$listener = New-Object System.Net.HttpListener
$prefix = "http://127.0.0.1:$Port/"
$expectedOrigin = ([uri]$prefix).GetLeftPart([System.UriPartial]::Authority)
$expectedHost = ([uri]$prefix).Authority
$maxBodyBytes = 15 * 1024 * 1024
$maxCsvBytes = 10 * 1024 * 1024
$bodyTimeoutSeconds = 10
$tokenBytes = New-Object byte[] 32
$random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $random.GetBytes($tokenBytes) } finally { $random.Dispose() }
$csrfToken = [Convert]::ToBase64String($tokenBytes)

function Throw-RequestError([int]$StatusCode, [string]$Message) {
    $requestError = New-Object System.InvalidOperationException -ArgumentList $Message
    $requestError.Data['StatusCode'] = $StatusCode
    throw $requestError
}

function Read-RequestBody($Request, [int]$Limit) {
    if ($Request.ContentLength64 -gt $Limit) { Throw-RequestError 413 'Request body too large.' }
    $buffer = New-Object byte[] 8192
    $body = New-Object System.IO.MemoryStream
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        while ($true) {
            $remaining = [int]($bodyTimeoutSeconds * 1000 - $timer.ElapsedMilliseconds)
            if ($remaining -le 0) { Throw-RequestError 408 'Request body timed out.' }
            $read = $Request.InputStream.ReadAsync($buffer, 0, $buffer.Length)
            if (-not $read.Wait($remaining)) { Throw-RequestError 408 'Request body timed out.' }
            $count = $read.Result
            if ($count -eq 0) { break }
            if ($body.Length + $count -gt $Limit) { Throw-RequestError 413 'Request body too large.' }
            $body.Write($buffer, 0, $count)
        }
        $utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false, $true
        return $utf8.GetString($body.ToArray())
    }
    finally {
        $body.Dispose()
        $Request.InputStream.Close()
    }
}

function Assert-ObjectShape($Value, [string[]]$Required, [string[]]$Allowed) {
    if ($Value -isnot [pscustomobject]) { throw 'A JSON object is required.' }
    $names = @($Value.PSObject.Properties.Name)
    foreach ($name in $Required) {
        if ($names -cnotcontains $name) { throw 'A required property is missing.' }
    }
    foreach ($name in $names) {
        if ($Allowed -cnotcontains $name) { throw 'An unsupported property was supplied.' }
    }
}

function Assert-Number($Value, [bool]$Positive = $false) {
    if ($Value -isnot [int] -and $Value -isnot [long] -and $Value -isnot [double] -and $Value -isnot [decimal]) {
        throw 'A numeric value is required.'
    }
    $number = [double]$Value
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number) -or $number -lt 0 -or ($Positive -and $number -le 0)) {
        throw 'A finite, non-negative numeric value is required.'
    }
}

function Assert-Symbol($Value) {
    if ($Value -isnot [string] -or $Value -cnotmatch '^[A-Za-z0-9^][A-Za-z0-9.^=_-]{0,23}$' -or
        @('__proto__', 'constructor', 'prototype') -contains $Value) {
        throw 'Invalid asset symbol.'
    }
}

function Assert-Date($Value) {
    $parsedDate = [datetime]::MinValue
    if ($Value -isnot [string] -or $Value -cnotmatch '^\d{4}-\d{2}-\d{2}$' -or
        -not [datetime]::TryParseExact($Value, 'yyyy-MM-dd', [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::None, [ref]$parsedDate)) {
        throw 'A valid date in YYYY-MM-DD format is required.'
    }
}

function Assert-PortfolioData($Data) {
    Assert-ObjectShape $Data @('transactions', 'quotes', 'history') @('transactions', 'quotes', 'history', 'settings')
    if ($Data.transactions -isnot [array] -or $Data.transactions.Count -gt 50000) { throw 'Invalid transactions array.' }
    foreach ($transaction in $Data.transactions) {
        $fields = @('symbol', 'type', 'date', 'quantity', 'price', 'commission')
        Assert-ObjectShape $transaction $fields $fields
        Assert-Symbol $transaction.symbol
        if (@('BUY', 'SELL') -cnotcontains $transaction.type) { throw 'Invalid transaction type.' }
        Assert-Date $transaction.date
        Assert-Number $transaction.quantity $true
        Assert-Number $transaction.price
        Assert-Number $transaction.commission
    }
    Assert-ObjectShape $Data.quotes @() @($Data.quotes.PSObject.Properties.Name)
    Assert-ObjectShape $Data.history @() @($Data.history.PSObject.Properties.Name)
    if (@($Data.quotes.PSObject.Properties).Count -gt 2000 -or @($Data.history.PSObject.Properties).Count -gt 2000) {
        throw 'Too many assets.'
    }
    foreach ($quote in $Data.quotes.PSObject.Properties) {
        Assert-Symbol $quote.Name
        Assert-Number $quote.Value
    }
    $pointCount = 0
    foreach ($asset in $Data.history.PSObject.Properties) {
        Assert-Symbol $asset.Name
        Assert-ObjectShape $asset.Value @() @($asset.Value.PSObject.Properties.Name)
        $pointCount += @($asset.Value.PSObject.Properties).Count
        if ($pointCount -gt 200000) { throw 'Too many historical prices.' }
        foreach ($point in $asset.Value.PSObject.Properties) {
            Assert-Date $point.Name
            Assert-Number $point.Value $true
        }
    }
    if (@($Data.PSObject.Properties.Name) -ccontains 'settings') {
        Assert-ObjectShape $Data.settings @('target') @('target')
        Assert-Number $Data.settings.target
    }
}

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
        Assert-PortfolioData $legacyData
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
$listener.TimeoutManager.HeaderWait = [timespan]::FromSeconds(15)
$listener.TimeoutManager.EntityBody = [timespan]::FromSeconds(15)
$listener.TimeoutManager.DrainEntityBody = [timespan]::FromSeconds(2)
$listener.Start()
Write-Host "BradTrack disponible en $prefix"
Write-Host 'Solo escucha en este equipo. Pulsa Ctrl+C para detenerlo.'

function Write-Response($Response, [int]$StatusCode, [string]$ContentType, [byte[]]$Bytes) {
    try {
        $Response.StatusCode = $StatusCode
        $Response.ContentType = $ContentType
        $Response.Headers['X-Content-Type-Options'] = 'nosniff'
        $Response.Headers['Cache-Control'] = 'no-store'
        $Response.Headers['Cross-Origin-Resource-Policy'] = 'same-origin'
        $Response.Headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        $Response.ContentLength64 = $Bytes.Length
        $Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
    }
    catch [System.Net.HttpListenerException] { }
    catch [System.IO.IOException] { }
    catch [System.ObjectDisposedException] { }
    finally { try { $Response.Close() } catch [System.Net.HttpListenerException] { } }
}

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        $path = $request.Url.AbsolutePath

        try {
            if ($request.Headers['Host'] -cne $expectedHost) { Throw-RequestError 403 'Unexpected host.' }
            if ($path.StartsWith('/api/', [System.StringComparison]::OrdinalIgnoreCase)) {
                $origin = $request.Headers['Origin']
                $fetchSite = $request.Headers['Sec-Fetch-Site']
                if (($origin -and $origin -cne $expectedOrigin) -or ($fetchSite -and $fetchSite -cne 'same-origin')) {
                    Throw-RequestError 403 'Only same-origin API requests are allowed.'
                }
                if ($request.HttpMethod -eq 'POST') {
                    if ($origin -cne $expectedOrigin -or $request.Headers['X-BradTrack-CSRF'] -cne $csrfToken) {
                        Throw-RequestError 403 'Invalid request origin or session token.'
                    }
                    if ($request.ContentType -notmatch '^application/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*$' -or
                        ($request.Headers['Content-Encoding'] -and $request.Headers['Content-Encoding'] -ne 'identity')) {
                        Throw-RequestError 415 'UTF-8 application/json is required.'
                    }
                }
            }

            if ($path -eq '/api/session' -and $request.HttpMethod -eq 'GET') {
                $bytes = [System.Text.Encoding]::UTF8.GetBytes((@{ csrfToken = $csrfToken } | ConvertTo-Json -Compress))
                Write-Response $response 200 'application/json; charset=utf-8' $bytes
                continue
            }

            if ($path -eq '/api/portfolios' -and $request.HttpMethod -eq 'GET') {
                Write-Response $response 200 'application/json; charset=utf-8' ([System.IO.File]::ReadAllBytes($portfolioIndexFile))
                continue
            }

            if ($path -eq '/api/portfolios' -and $request.HttpMethod -eq 'POST') {
                $body = Read-RequestBody $request 4096
                $newPortfolio = ConvertFrom-Json -InputObject $body
                Assert-ObjectShape $newPortfolio @('alias') @('alias')
                if ($newPortfolio.alias -isnot [string]) { throw 'Portfolio alias must be a string.' }
                $alias = ([string]$newPortfolio.alias).Trim()
                if ($alias.Length -lt 1 -or $alias.Length -gt 48 -or $alias -match '[\x00-\x1F\x7F]') { throw 'Invalid portfolio alias.' }
                $index = Get-Content -Path $portfolioIndexFile -Raw | ConvertFrom-Json
                if (@($index.portfolios).Count -ge 1000) { Throw-RequestError 409 'Portfolio limit reached.' }
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
                    $body = Read-RequestBody $request $maxBodyBytes
                    $parsed = ConvertFrom-Json -InputObject $body
                    Assert-PortfolioData $parsed
                    $temporaryFile = "$portfolioDataFile.tmp"
                    [System.IO.File]::WriteAllText($temporaryFile, $body, (New-Object System.Text.UTF8Encoding -ArgumentList $false))
                    Move-Item -Path $temporaryFile -Destination $portfolioDataFile -Force
                    Write-Response $response 200 'application/json; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('{"ok":true}'))
                    continue
                }

                if ($action -eq 'imports' -and $request.HttpMethod -eq 'POST') {
                    $body = Read-RequestBody $request $maxBodyBytes
                    $import = ConvertFrom-Json -InputObject $body
                    Assert-ObjectShape $import @('name', 'category', 'content') @('name', 'category', 'content')
                    if ($import.name -isnot [string] -or $import.name.Length -gt 180 -or $import.category -isnot [string] -or
                        $import.content -isnot [string] -or [System.IO.Path]::GetExtension($import.name) -ine '.csv' -or
                        [string]::IsNullOrWhiteSpace($import.content)) {
                        throw 'A non-empty CSV file is required.'
                    }
                    if ([System.Text.Encoding]::UTF8.GetByteCount($import.content) -gt $maxCsvBytes) {
                        Throw-RequestError 413 'CSV exceeds the 10 MB limit.'
                    }
                    $category = switch -CaseSensitive ($import.category) {
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
            $statusCode = 400
            if ($_.Exception.Data.Contains('StatusCode')) { $statusCode = [int]$_.Exception.Data['StatusCode'] }
            $message = [System.Text.Encoding]::UTF8.GetBytes('Request could not be processed.')
            Write-Response $response $statusCode 'text/plain; charset=utf-8' $message
            Write-Warning "Request rejected (HTTP $statusCode)."
        }
    }
}
finally {
    $listener.Stop()
    $listener.Close()
}
