@echo off
rem Boot dsh web with output captured to a log.
rem --no-open: restart must NOT spawn a new browser tab; the original page
rem auto-reloads itself after the self-check (client bundle).
rem Template from dsh-restart-plugin docs/setup; run install.ps1 (or fill the
rem values below manually) before first use.
cd /d "%USERPROFILE%"
call "__DSH_CMD__" web --no-open >> "__LOG_FILE__" 2>&1