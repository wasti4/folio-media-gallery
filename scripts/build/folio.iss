#if Ver < 0x06060000
  #error Inno Setup 6.6 or later is required.
#endif

#if FileExists(AddBackslash(CompilerPath) + "Languages\ChineseSimplified.isl")
  #define ChineseMessages
#endif

#ifndef FolioTestId
  #define FolioAppId "local.folio.media"
  #define FolioDirectory "Folio"
#else
  #define FolioAppId FolioTestId
  #define FolioDirectory "Folio Installer Test"
#endif

[Setup]
AppId={#FolioAppId}
AppName=Folio
AppVersion={#FolioVersion}
AppPublisher=Folio
DefaultDirName={localappdata}\Programs\{#FolioDirectory}
UsePreviousAppDir=yes
DisableDirPage=auto
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
SetupMutex=Local\{#FolioAppId}.setup
CloseApplications=yes
RestartApplications=no
UninstallDisplayName={#FolioDirectory}
UninstallDisplayIcon={app}\Folio.exe
SetupIconFile={#FolioPayload}\resources\icon.ico
OutputBaseFilename=Folio-{#FolioVersion}-Setup
VersionInfoVersion={#FolioVersion}
VersionInfoProductName=Folio
VersionInfoDescription=Folio Setup
WizardStyle=modern dynamic
Compression=lzma2/normal
LZMANumBlockThreads=4
SolidCompression=yes
#ifdef FolioSigning
SignTool=folio
SignedUninstaller=yes
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
#ifdef ChineseMessages
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
#endif

[Files]
Source: "{#FolioPayload}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

#ifndef FolioTestId
[Icons]
Name: "{autoprograms}\Folio"; Filename: "{app}\Folio.exe"; WorkingDir: "{app}"; AppUserModelID: "local.folio.media"
#endif

[Run]
#ifndef FolioTestId
Filename: "{app}\Folio.exe"; WorkingDir: "{app}"; Description: "{cm:LaunchProgram,Folio}"; Flags: nowait postinstall skipifsilent
#endif
; Folio's own updater runs Setup silently with /RELAUNCH=1 and expects to be started again afterwards.
Filename: "{app}\Folio.exe"; WorkingDir: "{app}"; Flags: nowait; Check: RelaunchAfterUpdate

[CustomMessages]
english.SeparateLibrary=Choose an installation folder outside the Folio library.
russian.SeparateLibrary=Выберите папку установки за пределами медиатеки Folio.
#ifdef ChineseMessages
chinesesimplified.SeparateLibrary=请选择 Folio 媒体库以外的安装目录。
#endif

[Code]
function RelaunchAfterUpdate: Boolean;
begin
  Result := WizardSilent and (ExpandConstant('{param:RELAUNCH|0}') = '1');
end;

function ContainsPath(ParentPath, ChildPath: String): Boolean;
begin
  Result := Pos(Lowercase(AddBackslash(ParentPath)), Lowercase(AddBackslash(ChildPath))) = 1;
end;

function Overlaps(FirstPath, SecondPath: String): Boolean;
begin
  Result := ContainsPath(FirstPath, SecondPath) or ContainsPath(SecondPath, FirstPath);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  InstallPath, ProfilePath: String;
begin
  Result := '';
  InstallPath := ExpandConstant('{app}');
  { The profile moves from the former Luma folder on first launch, so keep both clear of the program files. }
  if Overlaps(InstallPath, ExpandConstant('{userappdata}\Folio')) or
     Overlaps(InstallPath, ExpandConstant('{userappdata}\Luma')) then
    Result := CustomMessage('SeparateLibrary');
  ProfilePath := GetEnv('FOLIO_TEST_PROFILE');
  if (ProfilePath <> '') and Overlaps(InstallPath, ProfilePath) then
    Result := CustomMessage('SeparateLibrary');
#ifdef FolioTestId
  if (ProfilePath = '') or (not ContainsPath(ExtractFileDir(ProfilePath), InstallPath)) then
    Result := 'The test installer requires a separate program folder next to its test profile.';
#endif
end;
