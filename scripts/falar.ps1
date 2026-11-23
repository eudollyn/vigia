# Fala um texto com as vozes do Windows. Texto em Base64 (UTF-8).
# Com -Arquivo, grava um WAV (24 kHz, 16 bits, mono) em vez de tocar (para mandar ao notebook).
param([string]$TextoB64, [string]$Voz = 'Microsoft Maria Desktop', [int]$Velocidade = 1, [string]$Arquivo = '')
$texto = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TextoB64))
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $s.SelectVoice($Voz) } catch { try { $s.SelectVoiceByHints('Female', 'Adult', 0, [Globalization.CultureInfo]'pt-BR') } catch {} }
$s.Rate = [Math]::Max(-10, [Math]::Min(10, $Velocidade))
$s.Volume = 100
if ($Arquivo) {
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $s.SetOutputToWaveFile($Arquivo, $fmt)
}
$s.Speak($texto)
$s.Dispose()
