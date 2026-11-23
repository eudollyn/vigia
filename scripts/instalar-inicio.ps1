# Cria (ou remove, com -Remover) a tarefa que liga o Vigia quando você entra no Windows.
param([switch]$Remover)
$nome = 'Vigia de Mensagens'
if ($Remover) {
  Unregister-ScheduledTask -TaskName $nome -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Tarefa '$nome' removida."
  return
}
$vbs = Join-Path $PSScriptRoot 'iniciar-oculto.vbs'
$acao = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$gatilho = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$gatilho.Delay = 'PT30S'   # espera 30 s para a internet subir
$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $nome -Action $acao -Trigger $gatilho -Settings $ajustes -Description 'Lê WhatsApp e e-mail e avisa no PC (somente leitura).' -Force | Out-Null
Write-Host "Pronto: o Vigia vai ligar sozinho sempre que voce entrar no Windows."
