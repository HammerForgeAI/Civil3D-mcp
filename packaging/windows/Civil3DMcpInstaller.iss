; =============================================================================
; Civil 3D MCP — per-user Windows installer (Inno Setup 6)
; =============================================================================
; Installs the native plugin as an Autodesk ApplicationPlugins bundle:
;
;   %APPDATA%\Autodesk\ApplicationPlugins\Civil3DMcp.bundle
;     PackageContents.xml          (generated here, UTF-8 without BOM)
;     Contents\Civil3DMcpPlugin.dll and its build output
;
; It is the installer twin of scripts\install-bundle.ps1 and matches it exactly:
; the same bundle name, the same per-user ApplicationPlugins root, the same six
; denied Autodesk references, the same PackageContents.xml shape and GUIDs, the
; same series rule (net10.0-windows = Civil 3D 2027 = R26.0) and the same
; AppVersion taken from the built DLL's file version.
;
; Ported from the MIT-licensed donor installer of KevinGriffin/new_civil3d_mcp
; (installer/Civil3dMcpInstaller.iss, Copyright (c) 2026 Kevin Griffin). The
; donor installed a Python MCP server into Program Files with admin rights and
; configured claude_desktop_config.json. This fork has no Python server, so the
; recipe keeps the plugin-bundle component only: the MCP server ships as the
; Claude Desktop extension (scripts\package-claude-extension.mjs) or is
; registered with scripts\install-claude-mcp.ps1, and neither is an installed
; file. An [InstallDelete]-style removal of a hand-written Claude config would
; also be wrong, because Claude Desktop now owns extension state.
;
; BUILD THIS INSTALLER:
;   1. Build the plugin:  powershell -File scripts\build-2027.ps1
;      (output: Civil3D-MCP-Plugin\bin\Release\net10.0-windows)
;   2. Install Inno Setup 6 from https://jrsoftware.org/isinfo.php
;   3. Compile this script, or from the command line:
;        ISCC.exe /DMyAppVersion=1.2.1 packaging\windows\Civil3DMcpInstaller.iss
;   4. Output: dist\windows\Civil3DMcp-Setup-<version>.exe
;
; For a Civil 3D 2026 (net8.0-windows, series R25.1) build, compile with:
;   ISCC.exe /DSourceFramework=net8.0-windows /DSeries=R25.1 ...
;
; The recipe is not compiled by this repository: Inno Setup runs on Windows.
; =============================================================================

; Keep MyAppVersion in step with package.json (scripts\sync-version.mjs), or
; override it on the compiler command line with /DMyAppVersion=<version>.
#ifndef MyAppVersion
#define MyAppVersion "1.2.1"
#endif

; net10.0-windows is the Civil 3D 2027 (R26.0) build output. Override with
; /DSourceFramework=net8.0-windows /DSeries=R25.1 for a Civil 3D 2026 build.
#ifndef SourceFramework
#define SourceFramework "net10.0-windows"
#endif

; The bundle's RuntimeRequirements series must match the release the DLL was
; compiled against, or AutoCAD never loads it (see scripts\install-bundle.ps1).
#ifndef Series
#define Series "R26.0"
#endif

#define MyAppName "Civil 3D MCP Plugin"
#define MyAppPublisher "Sacred-G"
#define MyAppURL "https://github.com/Sacred-G/Civil3D-mcp"
#define BundleName "Civil3DMcp.bundle"
#define PluginDllName "Civil3DMcpPlugin.dll"
; The six Autodesk references are Private=false in the csproj, so they never
; reach bin\; deny-list them anyway so a hand-copied set cannot be shipped.
#define AutodeskReferenceExcludes "accoremgd.dll,AcDbMgd.dll,acmgd.dll,AecBaseMgd.dll,AeccDbMgd.dll,AeccPressurePipesMgd.dll"

[Setup]
AppId={{4D9A6C25-71B8-4E3F-8A5C-2B6E0F91DA73}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
; Per-user install: %APPDATA%\Autodesk\ApplicationPlugins is writable without
; elevation, which is why scripts\install-bundle.ps1 uses it.
PrivilegesRequired=lowest
DefaultDirName={userappdata}\Autodesk\ApplicationPlugins\{#BundleName}
DisableDirPage=yes
DisableProgramGroupPage=yes
; No Start menu group: the bundle is loaded by Civil 3D, not started by the user.
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
OutputDir=..\..\dist\windows
OutputBaseFilename=Civil3DMcp-Setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Windows 10 or later, 64-bit, matching Civil 3D. Inno Setup 6.3 or later
; (use ArchitecturesAllowed=x64 on 6.2 and earlier).
MinVersion=10.0
ArchitecturesAllowed=x64compatible
; Inno asks the user to close Civil 3D (or any process holding the DLL) through
; the Restart Manager. install-bundle.ps1 probes the same file locks directly;
; this is the Inno equivalent of that check.
CloseApplications=yes
RestartApplications=no
SetupLogging=yes
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\Contents\{#PluginDllName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; Everything the plugin build produced, minus the denied Autodesk references,
; into Contents\ — the same file set install-bundle.ps1 copies. The source path
; is relative to this script: packaging\windows\..\.. is the repository root.
Source: "..\..\Civil3D-MCP-Plugin\bin\Release\{#SourceFramework}\*"; DestDir: "{app}\Contents"; Excludes: "{#AutodeskReferenceExcludes}"; Flags: ignoreversion

[Registry]
; Detection metadata only. The bundle itself is discovered by Civil 3D through
; PackageContents.xml, not through the registry.
Root: HKCU; Subkey: "Software\Civil3DMcp"; ValueType: string; ValueName: "Version"; ValueData: "{#MyAppVersion}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Civil3DMcp"; ValueType: string; ValueName: "BundleDir"; ValueData: "{app}"
Root: HKCU; Subkey: "Software\Civil3DMcp"; ValueType: string; ValueName: "Series"; ValueData: "{#Series}"

[UninstallDelete]
; Leave no half-bundle behind when the user uninstalls.
Type: filesandordirs; Name: "{app}"

[Code]
const
  ProductCodeGuid = '{3F7C1A94-6E2D-4B85-9C13-5A8E0D2F7B41}';
  UpgradeCodeGuid = '{8B24E5D7-1C3F-4A69-B0E2-7D9146C8F3A5}';
  Civil3DSeries = '{#Series}';

function ReadPluginVersion(): String;
var
  Version: String;
begin
  { install-bundle.ps1 stamps the bundle with the built DLL's file version. }
  if GetVersionNumbersString(ExpandConstant('{app}\Contents\{#PluginDllName}'), Version) then
    Result := Version
  else
    Result := '{#MyAppVersion}';
end;

procedure WritePackageContentsXml();
var
  Lines: TArrayOfString;
  XmlPath: String;
begin
  XmlPath := ExpandConstant('{app}\PackageContents.xml');

  SetArrayLength(Lines, 19);
  Lines[0] := '<?xml version="1.0" encoding="utf-8"?>';
  Lines[1] := '<ApplicationPackage';
  Lines[2] := '  SchemaVersion="1.0"';
  Lines[3] := '  AppVersion="' + ReadPluginVersion() + '"';
  Lines[4] := '  Author="Sacred-G"';
  Lines[5] := '  ProductCode="' + ProductCodeGuid + '"';
  Lines[6] := '  UpgradeCode="' + UpgradeCodeGuid + '"';
  Lines[7] := '  Name="Civil 3D MCP Plugin"';
  Lines[8] := '  PreferNewestAcross="AppData|ProgramFiles"';
  Lines[9] := '  >';
  Lines[10] := '  <CompanyDetails Name="Sacred-G" Url="https://github.com/Sacred-G/Civil3D-mcp" Email="" />';
  Lines[11] := '  <RuntimeRequirements Platform="Civil3D" SeriesMin="' + Civil3DSeries + '" SeriesMax="' + Civil3DSeries + '" OS="Win64" SupportPath="./Contents" />';
  Lines[12] := '  <Components>';
  Lines[13] := '    <ComponentEntry AppName="Civil3DMcp" ModuleName="./Contents/{#PluginDllName}"';
  Lines[14] := '                    LoadOnAutoCADStartup="true" LoadOnRequest="false" AppDescription="Civil 3D MCP JSON-RPC bridge">';
  Lines[15] := '    </ComponentEntry>';
  Lines[16] := '  </Components>';
  Lines[17] := '  <DisplayInAppManager>true</DisplayInAppManager>';
  Lines[18] := '</ApplicationPackage>';

  { PackageContents.xml must be UTF-8 without BOM or AutoCAD ignores it. }
  if not SaveStringsToUTF8File(XmlPath, Lines, False) then
    RaiseException('Could not write ' + XmlPath);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    WritePackageContentsXml();
end;
