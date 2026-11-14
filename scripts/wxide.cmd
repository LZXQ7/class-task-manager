@echo off
chcp 65001 >nul
REM wechatide wrapper: it locates the IDE port file via USERPROFILE, which is empty
REM when invoked from Git Bash (falls back to a literal "~"). Pin both env vars here.
set "USERPROFILE=C:\Users\PC"
set "HOME=C:\Users\PC"
call "D:\Tencent\微信web开发者工具\wechatide.cmd" -c CodeBuddy %* --token nmkEq4RWyOooHmCXvAP8pKACPWZRcGWt
