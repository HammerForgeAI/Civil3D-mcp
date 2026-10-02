# Windows packaging

Two artefacts ship to a Windows workstation: the native plugin, and the MCP
server. They install differently, and only the plugin needs an installer.

## `Civil3DMcpInstaller.iss` (Inno Setup 6)

Installs the plugin as a per-user Autodesk `ApplicationPlugins` bundle:

```
%APPDATA%\Autodesk\ApplicationPlugins\Civil3DMcp.bundle\
  PackageContents.xml                     generated at install time
  Contents\Civil3DMcpPlugin.dll           plus the rest of the build output
```

The recipe matches `scripts\install-bundle.ps1`: same bundle name, same per-user
root, same six denied Autodesk references, same `PackageContents.xml` shape and
GUIDs, same series rule and the same `AppVersion` read from the built DLL. It
needs no elevation. Inno Setup asks the user to close Civil 3D through the
Restart Manager, which is the installer's form of the file-lock probe in
`install-bundle.ps1`.

Build it:

```powershell
powershell -File scripts\build-2027.ps1
ISCC.exe packaging\windows\Civil3DMcpInstaller.iss
```

Output: `dist\windows\Civil3DMcp-Setup-<version>.exe`. The plugin must be built
first, because the installer packages the build output and Inno Setup refuses a
missing source file.

Port to another Civil 3D release with defines:

```powershell
ISCC.exe /DSourceFramework=net8.0-windows /DSeries=R25.1 /DMyAppVersion=1.2.1 `
  packaging\windows\Civil3DMcpInstaller.iss
```

## What this recipe does not install

The donor installer also deployed a Python MCP server into `Program Files`,
`pip install`ed its dependencies and wrote `claude_desktop_config.json`. This
fork has no Python server: the MCP server is Node and ships as the Claude
Desktop extension built by `scripts\package-claude-extension.mjs`, and Claude
Code registers it with `scripts\install-claude-mcp.ps1`. Both are owned by their
client, so the installer does not touch them.

The recipe is not compiled by this repository. Inno Setup runs on Windows, and
no Windows build agent is attached here, so `Civil3DMcpInstaller.iss` is a
reviewed recipe rather than a verified artefact.
