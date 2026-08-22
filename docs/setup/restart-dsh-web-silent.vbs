' restart-dsh-web-silent.vbs - windowless launcher for restart-dsh-web.ps1.
' Template from dsh-restart-plugin docs/setup; run install.ps1 (or fill the
' values below manually) before first use.
'
' wscript.exe is a GUI-subsystem host: running the restart script through it
' guarantees no console window ever appears on the desktop. The page-side
' pending state (light-grey text, dsh-restart-plugin client bundle) is the
' user's countdown UI; this launcher only makes the PowerShell half invisible.
CreateObject("WScript.Shell").Run _
  "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""__PS1_FILE__"" -Mode Grace -Seconds __SECONDS__", _
  0, False