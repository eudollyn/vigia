# Mostra uma notificação do Windows. Recebe título e texto em Base64 (UTF-8) para não quebrar acentos.
param([string]$TituloB64, [string]$TextoB64, [string]$Urgente = '0')
$ErrorActionPreference = 'Stop'
$dec = { param($b) [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) }
$titulo = & $dec $TituloB64
$texto  = & $dec $TextoB64
$esc = { param($s) [Security.SecurityElement]::Escape($s) }

[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

$cenario = if ($Urgente -eq '1') { ' scenario="reminder"' } else { '' }
$acoes   = if ($Urgente -eq '1') { '<actions><action content="OK" arguments="ok" activationType="system"/></actions>' } else { '' }
$xml = @"
<toast$cenario>
  <visual><binding template="ToastGeneric">
    <text>$(& $esc $titulo)</text>
    <text>$(& $esc $texto)</text>
  </binding></visual>
  <audio src="ms-winsoundevent:Notification.IM"/>
  $acoes
</toast>
"@
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
# AppId do PowerShell, já registrado no Windows (permite notificar sem instalar nada).
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($doc))
