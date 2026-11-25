# Vigia · conectar ao ChatGPT: guarda o token (e o domínio fixo) do ngrok no .env, reinicia o Vigia e mostra o endereço.
$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$env_ = Join-Path $raiz '.env'
$link = Join-Path $raiz 'LINK-DO-CHATGPT.txt'
$utf8 = New-Object System.Text.UTF8Encoding($false)

Write-Host ''
Write-Host '  CONECTAR O VIGIA AO CHATGPT' -ForegroundColor Cyan
Write-Host '  ---------------------------'
Write-Host '  1. Entre em https://dashboard.ngrok.com (crie a conta, e gratis).'
Write-Host '  2. Menu "Your Authtoken": copie o token.'
Write-Host '  3. Menu "Domains": copie o seu dominio fixo (algo.ngrok-free.dev).'
Write-Host ''
$token = Read-Host '  Cole o token do ngrok (Enter = manter o atual)'
$dominio = Read-Host '  Cole o dominio fixo (Enter = manter o atual)'

$linhas = @()
if (Test-Path $env_) { $linhas = [System.IO.File]::ReadAllLines($env_, $utf8) }
function Definir([string]$chave, [string]$valor) {
  if (-not $valor) { return }
  $valor = $valor.Trim()
  $achou = $false
  for ($i = 0; $i -lt $script:linhas.Count; $i++) {
    if ($script:linhas[$i] -match "^\s*$chave\s*=") { $script:linhas[$i] = "$chave=$valor"; $achou = $true }
  }
  if (-not $achou) { $script:linhas += "$chave=$valor" }
}
Definir 'GPT' '1'
Definir 'NGROK_TOKEN' $token
Definir 'NGROK_DOMINIO' (($dominio -replace '^https?://', '') -replace '/.*$', '')
[System.IO.File]::WriteAllLines($env_, $linhas, $utf8)

Write-Host ''
Write-Host '  Reiniciando o Vigia...' -ForegroundColor Yellow
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src\\index\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2
Start-Process wscript.exe -ArgumentList ('"' + (Join-Path $raiz 'scripts\iniciar-oculto.vbs') + '"')
$antes = if (Test-Path $link) { (Get-Item $link).LastWriteTime } else { [datetime]::MinValue }
for ($i = 0; $i -lt 90; $i++) {
  Start-Sleep -Seconds 1
  if ((Test-Path $link) -and (Get-Item $link).LastWriteTime -gt $antes) { break }
}
Write-Host ''
if (Test-Path $link) { Get-Content $link -Encoding UTF8 | ForEach-Object { Write-Host "  $_" } } else { Write-Host '  O Vigia ainda nao respondeu. Abra o LINK-DO-CHATGPT.txt daqui a pouco.' }
Write-Host ''
Write-Host '  No ChatGPT: abra chatgpt.com/plugins > Adicionar servidor MCP personalizado,'
Write-Host '  nome "Vigia", cole o endereco acima, Autenticacao: "Sem autenticacao".'
Write-Host ''
Read-Host '  Enter para fechar'
