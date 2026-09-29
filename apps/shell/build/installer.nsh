; Keeps the genoffice command line (resources\cli, holding genoffice.cmd and the
; extension-less genoffice for Git Bash) on the installing user's PATH for the
; lifetime of the install. The value is read and written unexpanded
; (REG_EXPAND_SZ) so entries such as %USERPROFILE%\bin survive, and Explorer
; is told about the change so terminals opened afterwards see it.
; electron-builder compiles the script twice (the second pass, with
; BUILD_UNINSTALLER, only produces the uninstaller); an unreferenced function
; in either pass is a warning makensis treats as an error, hence the guards.
!include "WinMessages.nsh"
!include "StrFunc.nsh"

!define GENOFFICE_PATH_MAX 7900

; Scope templates to our ProgIDs (electron-builder uses fileAssociations.name).
; A shared .ext\ShellNew would overwrite Office/WPS templates. OOXML files
; must be copied from valid packages, never created with NullFile.
!macro GenOfficeRegisterShellNew EXT PROGID
  WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}\${PROGID}\ShellNew" "FileName" "$INSTDIR\resources\shell-new\blank.${EXT}"
!macroend

!macro GenOfficeUnregisterShellNew EXT PROGID
  ; Only remove our own registration, including when uninstalling for an update.
  ReadRegStr $0 SHELL_CONTEXT "Software\Classes\.${EXT}\${PROGID}\ShellNew" "FileName"
  ${If} $0 == "$INSTDIR\resources\shell-new\blank.${EXT}"
    DeleteRegKey SHELL_CONTEXT "Software\Classes\.${EXT}\${PROGID}\ShellNew"
    DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.${EXT}\${PROGID}"
  ${EndIf}
!macroend

!macro customInstall
  Push "$INSTDIR\resources\cli"
  Call GenOfficeAddToUserPath
  !insertmacro GenOfficeRegisterShellNew "docx" "Word Document"
  !insertmacro GenOfficeRegisterShellNew "xlsx" "Excel Workbook"
  !insertmacro GenOfficeRegisterShellNew "pptx" "PowerPoint Presentation"
  !insertmacro UPDATEFILEASSOC
  ; remember the document library folder picked on the custom page (or the
  ; default on silent installs); the app adopts it on first launch
  StrCmp $LibraryDirValue "" 0 +3
  Call GenOfficeDefaultLibraryDir
  Pop $LibraryDirValue
  WriteRegStr HKCU "Software\GenOffice" "LibraryDir" "$LibraryDirValue"
!macroend

!macro customUnInstall
  Push "$INSTDIR\resources\cli"
  Call un.GenOfficeRemoveFromUserPath
  Push $0
  !insertmacro GenOfficeUnregisterShellNew "docx" "Word Document"
  !insertmacro GenOfficeUnregisterShellNew "xlsx" "Excel Workbook"
  !insertmacro GenOfficeUnregisterShellNew "pptx" "PowerPoint Presentation"
  Pop $0
  !insertmacro UPDATEFILEASSOC
!macroend

!ifndef BUILD_UNINSTALLER
${StrStr}

Function GenOfficeAddToUserPath
  Exch $0 ; directory
  Push $1
  Push $2
  Push $3
  ReadRegStr $1 HKCU "Environment" "Path"
  StrLen $2 $1
  ; leave an already oversized PATH alone rather than truncate it
  IntCmp $2 ${GENOFFICE_PATH_MAX} done 0 done
  ${StrStr} $3 ";$1;" ";$0;"
  StrCmp $3 "" 0 done
  StrCmp $1 "" 0 +3
    StrCpy $1 "$0"
    Goto write
  StrCpy $1 "$1;$0"
write:
  WriteRegExpandStr HKCU "Environment" "Path" $1
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
done:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!endif

!ifdef BUILD_UNINSTALLER
${UnStrStr}
${UnStrRep}

Function un.GenOfficeRemoveFromUserPath
  Exch $0 ; directory
  Push $1
  Push $2
  ReadRegStr $1 HKCU "Environment" "Path"
  StrCmp $1 "" done
  ${UnStrStr} $2 ";$1;" ";$0;"
  StrCmp $2 "" done
  StrCpy $1 ";$1;"
  ${UnStrRep} $1 $1 ";$0;" ";"
  ; strip the sentinels added above
  StrCpy $1 $1 -1
  StrCpy $1 $1 "" 1
  WriteRegExpandStr HKCU "Environment" "Path" $1
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
done:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!endif

!macro customInit
  Call GenOfficeDefaultLibraryDir
  Pop $LibraryDirValue
!macroend

!macro customPageAfterChangeDir
  Page custom LibraryDirPageCreate LibraryDirPageLeave
!macroend

; ---- document library location page -----------------------------------------
; Shown after the install-directory page. The picked folder is written to
; HKCU\Software\GenOffice\LibraryDir and adopted by the app on first launch.
; Chinese text is stored as NSIS "${U+XXXX}" escapes so this file stays pure
; ASCII: the include is processed before MUI2/LogicLib in the generated
; script, and this makensis build rejects non-ASCII include content under
; CJK system locales.

!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
Var LibraryDirCtl
Var LibraryDirValue
!endif

LangString GenOfficeLibraryTitle 1033 "Document library"
LangString GenOfficeLibraryTitle 2052 "${U+6587}${U+6863}${U+5E93}"
LangString GenOfficeLibraryTitle 1028 "${U+6587}${U+4EF6}${U+5EAB}"
LangString GenOfficeLibrarySub 1033 "Choose where imported documents are kept."
LangString GenOfficeLibrarySub 2052 "${U+9009}${U+62E9}${U+5BFC}${U+5165}${U+6587}${U+6863}${U+7684}${U+5B58}${U+653E}${U+4F4D}${U+7F6E}${U+3002}"
LangString GenOfficeLibrarySub 1028 "${U+9078}${U+64C7}${U+532F}${U+5165}${U+6587}${U+4EF6}${U+7684}${U+5B58}${U+653E}${U+4F4D}${U+7F6E}${U+3002}"
LangString GenOfficeLibraryDesc 1033 "Opened documents are copied into this folder; edits and saves never touch the originals."
LangString GenOfficeLibraryDesc 2052 "${U+6253}${U+5F00}${U+7684}${U+6587}${U+6863}${U+4F1A}${U+590D}${U+5236}${U+5230}${U+8FD9}${U+4E2A}${U+6587}${U+4EF6}${U+5939}${U+FF1B}${U+7F16}${U+8F91}${U+548C}${U+4FDD}${U+5B58}${U+90FD}${U+4E0D}${U+4F1A}${U+6539}${U+52A8}${U+539F}${U+6587}${U+4EF6}${U+3002}"
LangString GenOfficeLibraryDesc 1028 "${U+958B}${U+555F}${U+7684}${U+6587}${U+4EF6}${U+6703}${U+8907}${U+88FD}${U+5230}${U+9019}${U+500B}${U+8CC7}${U+6599}${U+593E}${U+FF1B}${U+7DE8}${U+8F2F}${U+548C}${U+5132}${U+5B58}${U+90FD}${U+4E0D}${U+6703}${U+6539}${U+52D5}${U+539F}${U+59CB}${U+6A94}${U+6848}${U+3002}"
LangString GenOfficeLibraryBrowse 1033 "Browse..."
LangString GenOfficeLibraryBrowse 2052 "${U+6D4F}${U+89C8}..."
LangString GenOfficeLibraryBrowse 1028 "${U+700F}${U+89BD}..."

; default: D:\ProgramData\genoffice when drive D: exists, else per-user folder
!ifndef BUILD_UNINSTALLER
Function GenOfficeDefaultLibraryDir
  StrCpy $0 "D:\ProgramData\genoffice"
  IfFileExists "D:\*.*" default_drive_ok 0
    StrCpy $0 "$APPDATA\GenOffice\library"
  default_drive_ok:
  Push $0
FunctionEnd
!endif

!ifndef BUILD_UNINSTALLER
Function LibraryDirPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0u 100% 16u "$(GenOfficeLibraryTitle)"
  Pop $0
  ${NSD_CreateLabel} 0 18u 100% 24u "$(GenOfficeLibraryDesc)"
  Pop $0
  ${NSD_CreateText} 0 50u 78% 13u "$LibraryDirValue"
  Pop $LibraryDirCtl
  ${NSD_CreateBrowseButton} 80% 49u 20% 15u "$(GenOfficeLibraryBrowse)"
  Pop $1
  ${NSD_OnClick} $1 LibraryDirBrowse
  nsDialogs::Show
FunctionEnd

Function LibraryDirBrowse
  ${NSD_GetText} $LibraryDirCtl $2
  nsDialogs::SelectFolderDialog "$(GenOfficeLibraryBrowse)" "$2"
  Pop $2
  StrCmp $2 "error" +2 0
  ${NSD_SetText} $LibraryDirCtl "$2"
FunctionEnd

Function LibraryDirPageLeave
  ${NSD_GetText} $LibraryDirCtl $LibraryDirValue
  ; strip one trailing backslash (keep a drive root like "D:\")
  StrLen $1 "$LibraryDirValue"
  IntCmp $1 3 leave leave 0
    StrCpy $2 "$LibraryDirValue" 1 -1
    StrCmp $2 "\" leave 0
    StrCpy $LibraryDirValue "$LibraryDirValue" -1
  leave:
FunctionEnd
!endif
