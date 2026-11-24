# Vigia - Ligar o PC
# Roda no NOTEBOOK quando você desbloqueia ou quando ele volta da suspensão (tampa aberta).
# Se o PC estiver desligado: fala "Ligando o PC", manda o sinal de ligar pela rede (Wake-on-LAN)
# e espera ele subir. Quando o Vigia liga no PC, a página do notebook reconecta e ele fala o bom dia.
# Use -Teste para mandar o sinal mesmo com o PC ligado (só para conferir que funciona).
param([switch]$Teste)

$MAC       = '{{MAC}}'
$IP_PC     = '{{IP}}'
$PORTA     = {{PORTA}}
$BROADCAST = '{{BROADCAST}}'
$LINK      = '{{LINK}}'

$pasta  = Split-Path -Parent $MyInvocation.MyCommand.Path
$logArq = Join-Path $pasta 'ligar-pc.log'
function Log($t) { "[$(Get-Date -Format 'dd/MM/yyyy HH:mm:ss')] $t" | Out-File -Append -Encoding utf8 $logArq }

function PcLigado {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $ok = $c.ConnectAsync($IP_PC, $PORTA).Wait(1500) -and $c.Connected
    $c.Close(); return $ok
  } catch { return $false }
}

function Falar($t, $arquivo) {
  # a fala gravada com a voz do Vigia (Francisca); a voz do Windows só se o arquivo faltar
  $wav = if ($arquivo) { Join-Path $pasta $arquivo } else { $null }
  if ($wav -and (Test-Path $wav)) {
    try { $p = New-Object Media.SoundPlayer $wav; $p.PlaySync(); $p.Dispose(); return } catch {}
  }
  try {
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'pt-BR' } | Select-Object -First 1
    if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }
    $s.Speak($t); $s.Dispose()
  } catch {}
}

function MandarSinal {
  # pacote mágico: 6 bytes 0xFF + o endereço físico (MAC) do PC repetido 16 vezes
  $mac = ($MAC -split '[-:]') | ForEach-Object { [Convert]::ToByte($_, 16) }
  $pacote = [byte[]]((,0xFF * 6) + ($mac * 16))
  $u = New-Object Net.Sockets.UdpClient
  $u.EnableBroadcast = $true
  foreach ($destino in @($BROADCAST, '255.255.255.255')) {
    foreach ($porta in 9, 7) { try { [void]$u.Send($pacote, $pacote.Length, $destino, $porta) } catch {} }
  }
  $u.Close()
}

# uma execução por vez (desbloquear e voltar da suspensão disparam juntos)
$trava = New-Object Threading.Mutex($false, 'Local\VigiaLigarPC')
if (-not $trava.WaitOne(0)) { exit }

try {
  # depois da suspensão o Wi-Fi demora alguns segundos para voltar
  $ini = Get-Date
  while (((Get-Date) - $ini).TotalSeconds -lt 25) {
    if (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -like '192.168.*' }) { break }
    Start-Sleep 2
  }
  Start-Sleep 2

  if ((PcLigado) -and -not $Teste) { Log 'PC já estava ligado: nada a fazer.'; exit }

  Log 'PC desligado: mandando o sinal para ligar.'
  Falar 'Ligando o PC.' 'ligando.wav'
  1..3 | ForEach-Object { MandarSinal; Start-Sleep 1 }
  if ($Teste) { Log 'Teste: sinal enviado.'; exit }

  # espera o PC subir (até 5 min), mandando o sinal de novo a cada ~30 s
  $ini = Get-Date; $ultimo = Get-Date
  while (((Get-Date) - $ini).TotalSeconds -lt 300) {
    if (PcLigado) { break }
    if (((Get-Date) - $ultimo).TotalSeconds -ge 30) { MandarSinal; $ultimo = Get-Date }
    Start-Sleep 3
  }
  if (-not (PcLigado)) {
    Log 'O PC não respondeu em 5 minutos.'
    Falar 'O PC não ligou. Confira se ele está na tomada e no cabo de rede.' 'nao-ligou.wav'
    exit
  }
  Log 'PC ligou.'

  # dá tempo de o Vigia iniciar; se a página do Vigia não estiver aberta neste notebook, abre
  Start-Sleep 30
  try {
    $status = Invoke-RestMethod ($LINK -replace '/\?k=', '/status?k=') -TimeoutSec 5
    if ($status.notebooks -lt 1) { Log 'Abrindo a página do Vigia.'; Start-Process $LINK }
  } catch { Log 'Vigia ainda não respondeu; abrindo a página.'; Start-Process $LINK }
} finally {
  $trava.ReleaseMutex()
}
