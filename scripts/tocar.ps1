# Toca um arquivo WAV e espera terminar.
param([string]$Arquivo)
$p = New-Object System.Media.SoundPlayer $Arquivo
$p.PlaySync()
$p.Dispose()
