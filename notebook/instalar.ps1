# Instala o "Ligar o PC" neste notebook (só para o seu usuário, não precisa ser administrador).
# Cria a tarefa "Vigia - Ligar o PC", que roda ao entrar no Windows, ao desbloquear e ao voltar da suspensão.
$ErrorActionPreference = 'Stop'
$origem  = Split-Path -Parent $MyInvocation.MyCommand.Path
$destino = Join-Path $env:LOCALAPPDATA 'VigiaLigarPC'
New-Item -ItemType Directory -Force $destino | Out-Null
Copy-Item (Join-Path $origem 'ligar-pc.ps1') $destino -Force
Copy-Item (Join-Path $origem '*.wav') $destino -Force -ErrorAction SilentlyContinue  # falas com a voz do Vigia
# Identidade visual: o ZIP distribuido pelo Vigia inclui o icone.
$icoOrigem = Join-Path $origem 'vigia.ico'
$icoDestino = Join-Path $destino 'vigia.ico'
if (Test-Path -LiteralPath $icoOrigem) {
  Copy-Item -LiteralPath $icoOrigem -Destination $icoDestino -Force
  $linkVigia = '{{LINK}}'
  if ($linkVigia -match '^https?://') {
    $ws = New-Object -ComObject WScript.Shell
    $pastas = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
    foreach ($pastaAtalho in $pastas) {
      if (-not $pastaAtalho -or -not (Test-Path -LiteralPath $pastaAtalho)) { continue }
      $atalho = $ws.CreateShortcut((Join-Path $pastaAtalho 'Vigia.lnk'))
      $atalho.TargetPath = Join-Path $env:WINDIR 'explorer.exe'
      $atalho.Arguments = '"' + $linkVigia + '"'
      $atalho.IconLocation = $icoDestino + ',0'
      $atalho.Description = 'Abrir Vigia'
      $atalho.Save()
    }
  }
}
$script = Join-Path $destino 'ligar-pc.ps1'
Unblock-File $script -ErrorAction SilentlyContinue

$acao = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""

$ns = 'Root/Microsoft/Windows/TaskScheduler'
# ao desbloquear (8 = desbloqueio da sessão)
$desbloqueio = New-CimInstance -CimClass (Get-CimClass -ClassName MSFT_TaskSessionStateChangeTrigger -Namespace $ns) -ClientOnly -Property @{ Enabled = $true; StateChange = [uint32]8; UserId = "$env:USERDOMAIN\$env:USERNAME" }
# ao voltar da suspensão (abrir a tampa), mesmo sem tela de bloqueio
$consulta = "<QueryList><Query Id='0' Path='System'><Select Path='System'>*[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1]]</Select></Query></QueryList>"
$retorno = New-CimInstance -CimClass (Get-CimClass -ClassName MSFT_TaskEventTrigger -Namespace $ns) -ClientOnly -Property @{ Enabled = $true; Subscription = $consulta }
# ao entrar no Windows
$logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"

$config = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable
Register-ScheduledTask -TaskName 'Vigia - Ligar o PC' -Action $acao -Trigger @($desbloqueio, $retorno, $logon) -Settings $config -Force | Out-Null

Write-Host ''
Write-Host 'Pronto! O "Ligar o PC" foi instalado neste notebook.' -ForegroundColor Green
Write-Host 'Quando você desbloquear ou abrir a tampa com o PC desligado, ele fala "Ligando o PC" e liga.'
Write-Host ''
$r = Read-Host 'Quer testar agora? Ele fala "Ligando o PC" e manda o sinal (o PC ligado não é afetado). S/N'
if ($r -match '^[sS]') { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -Teste; Write-Host 'Sinal enviado. Registro em:' (Join-Path $destino 'ligar-pc.log') }
