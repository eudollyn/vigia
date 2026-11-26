# Instalador do Vigia (Windows). Rode pelo INSTALAR.bat.
# Mensagens sem acento de proposito: o PowerShell 5.1 do Windows mostra acentos errado em alguns sistemas.
$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
Set-Location $raiz

function Titulo($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Yellow }
function Ok($t) { Write-Host "   [ok] $t" -ForegroundColor Green }
function Aviso($t) { Write-Host "   [!]  $t" -ForegroundColor DarkYellow }
function Pergunta($t) { $r = Read-Host "   $t (s/n)"; return $r -match '^[sSyY]' }

Write-Host ""
Write-Host "   VIGIA - leitor de WhatsApp e e-mail com voz" -ForegroundColor Cyan
Write-Host "   --------------------------------------------" -ForegroundColor Cyan

# 1) Node.js
Titulo "1/5 Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Aviso "Node.js nao encontrado."
  if (Pergunta "Instalar o Node.js LTS agora pelo winget?") {
    winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    Aviso "Feche esta janela e rode o INSTALAR.bat de novo (para o Windows enxergar o Node)."
    exit 0
  } else { Aviso "Instale em https://nodejs.org e rode o INSTALAR.bat de novo."; exit 1 }
}
$versao = [int]((node -v).TrimStart('v').Split('.')[0])
if ($versao -lt 22) { Aviso "Node $((node -v)) e antigo. Instale a versao 22.13 ou mais nova em https://nodejs.org"; exit 1 }
Ok "Node $(node -v)"

# 2) ffmpeg (voz Microsoft e microfone do PC)
Titulo "2/5 ffmpeg"
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) { Ok "ffmpeg encontrado" }
else {
  Aviso "ffmpeg nao encontrado (usado pela voz neural e pelo microfone do PC)."
  if (Pergunta "Instalar o ffmpeg agora pelo winget?") {
    winget install -e --id Gyan.FFmpeg --accept-package-agreements --accept-source-agreements
    Aviso "Depois da instalacao, feche e abra a janela para o Windows enxergar o ffmpeg."
  } else { Aviso "Sem ffmpeg o Vigia usa a voz do Windows e o microfone do notebook." }
}

# 3) Dependencias
Titulo "3/5 Dependencias"
npm ci --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { Aviso "npm ci falhou, tentando npm install..."; npm install --no-fund --no-audit }
Ok "Dependencias instaladas"

# 4) Configuracao
Titulo "4/5 Configuracao"
if (-not (Test-Path .env)) { Copy-Item .env.example .env; Ok "Arquivo .env criado a partir do .env.example" } else { Ok ".env ja existe (mantido)" }

# 5) Assistente (no navegador): explica como funciona, testa a IA e o e-mail, conecta o WhatsApp e grava o .env
Titulo "5/5 Assistente de configuracao"
Write-Host "   Vai abrir uma pagina no navegador que explica tudo e configura com voce."
Write-Host "   Quando terminar, feche a pagina e volte aqui (ou feche esta janela)."
Write-Host ""
node src\configurar.js
Write-Host ""
Write-Host "   Para mudar a configuracao depois, rode o CONFIGURAR.bat." -ForegroundColor Cyan
Write-Host ""
