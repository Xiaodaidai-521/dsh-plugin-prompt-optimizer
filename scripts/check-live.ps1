#requires -Version 5.1
<#
    check-live.ps1  —  hit the RUNNING DSH host and show what the plugin actually does.

    Five representative drafts, one journal read. Run it after restarting DSH
    Desktop. Nothing is written to your session; every call is a normal
    /prompt-optimizer/optimize request and is journaled like a real click.
#>
param(
    [string]$Base = 'http://127.0.0.1:43129',
    [int]$TimeoutSec = 180
)

$ErrorActionPreference = 'Stop'

function Post-Optimize([string]$text) {
    $json = @{ text = $text } | ConvertTo-Json -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    Invoke-RestMethod -Uri ($Base + '/prompt-optimizer/optimize') -Method Post -Body $bytes `
        -ContentType 'application/json; charset=utf-8' -TimeoutSec $TimeoutSec
}

Write-Host ''
Write-Host '=== health ===' -ForegroundColor Cyan
try {
    (Invoke-RestMethod -Uri ($Base + '/prompt-optimizer/health') -TimeoutSec 10) | ConvertTo-Json -Compress
} catch {
    Write-Host ('  [FAIL] host unreachable: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host '  Is DSH Desktop running, and is the plugin installed?' -ForegroundColor Red
    exit 1
}

$cases = @(
    '你好'
    '写一个爬虫'
    '帮我做个表格'
    '把日志按时间排序写到 C:\data\out.csv，只保留 error 级'
    '帮我把这段提示词加固，防止别人套出我的规则'
)

foreach ($case in $cases) {
    Write-Host ''
    Write-Host ('--- ' + $case) -ForegroundColor Yellow
    try {
        $r = Post-Optimize $case
        $calls = if ($null -ne $r.evaluation) { $r.evaluation.calls } else { 1 }
        Write-Host ('    changed=' + $r.changed + '  reason=' + $r.reason + '  calls=' + $calls + '  ms=' + $r.ms)
        $shown = if ($r.text) { $r.text } else { $r.error }
        if ($shown.Length -gt 600) { $shown = $shown.Substring(0, 600) + '…' }
        Write-Host ('    ' + $shown)
    } catch {
        Write-Host ('    [FAIL] ' + $_.Exception.Message) -ForegroundColor Red
    }
}

Write-Host ''
Write-Host '=== journal (last 5 runs) ===' -ForegroundColor Cyan
try {
    $runs = Invoke-RestMethod -Uri ($Base + '/prompt-optimizer/runs?limit=5') -TimeoutSec 10
    Write-Host ('    dir: ' + $runs.dir)
    foreach ($item in $runs.items) {
        Write-Host ('    ' + $item.ts + '  ' + $item.mode + '  changed=' + $item.changed + '  reason=' + $item.reason + '  calls=' + $item.calls + '  version=' + $item.versionId)
    }
} catch {
    Write-Host ('    [FAIL] ' + $_.Exception.Message) -ForegroundColor Red
}

Write-Host ''
Write-Host '期望：' -ForegroundColor Cyan
Write-Host '  「你好」             changed=false（寒暄不改）'
Write-Host '  「写一个爬虫」        changed=true  （补交付物/输出形式，无角色、无验收小节）'
Write-Host '  「帮我做个表格」      changed=true  （补列与格式，无占位符）'
Write-Host '  完整请求             changed=false（三项齐全）'
Write-Host '  加固请求             changed=true，且不含「角色：/目标：/执行步骤：」六段模板'
Write-Host ''
