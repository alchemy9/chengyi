@echo off
chcp 65001 >nul
cd /d "%~dp0server"
for %%V in (3.14 3.13 3.12) do (
  py -%%V -c "import sys; sys.exit(sys.version_info < (3, 12))" >nul 2>&1
  if not errorlevel 1 (
    py -%%V scripts\launch_shared.py
    goto finish
  )
)
python -c "import sys; sys.exit(sys.version_info < (3, 12))" >nul 2>&1
if not errorlevel 1 (
  python scripts\launch_shared.py
  goto finish
)
if exist ".venv\Scripts\python.exe" (
  .venv\Scripts\python.exe -c "import sys; sys.exit(sys.version_info < (3, 12))" >nul 2>&1
  if not errorlevel 1 (
    .venv\Scripts\python.exe scripts\launch_shared.py
    goto finish
  )
)
echo 没有找到 Python 3.12 或更新版本。
echo 请打开 https://www.python.org/downloads/ 下载安装 Python 3.12 以上版本，安装时勾选 "Add python.exe to PATH"。
:finish
pause
