# Stops everything J.A.R.V.I.S. started, and nothing else.
#
# Matched on the command line rather than on the process name: killing every
# node.exe would take out anything else you happen to be running, and killing
# every chrome.exe would close your actual browsing.

Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*JarvisApp*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# The launcher is the parent of both the bridge and the dev server, so taking
# the tree down takes all three.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*scripts/start.mjs*' } |
  ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }

# Anything left holding the ports — a bridge whose parent died, say. The launcher
# may have spawned it as bridge\server.mjs or bridge/server.mjs depending on how
# it was started; either spelling is the bridge.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*bridge\server.mjs*' -or $_.CommandLine -like '*bridge/server.mjs*' -or $_.CommandLine -like '*vite*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
