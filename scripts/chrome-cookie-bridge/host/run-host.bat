@echo off
REM Chrome launches this; it just runs the Node host next to it.
REM %~dp0 = this file's directory (with trailing backslash). node must be on PATH.
node "%~dp0ichiba_cookie_host.mjs"
