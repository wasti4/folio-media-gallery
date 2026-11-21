# Folio

Folio is a local media gallery for Windows 10 and later (x64). Browse photos, GIFs, and videos, organize a library, and watch series with external audio and subtitles.

Find installers in [GitHub Releases](https://github.com/wasti4/folio-media-gallery/releases). The installer updates an existing per-user installation. After a local installer build, run `release/Folio-<version>-Setup.exe`. For the portable build, keep the `release/Folio-<version>/` folder intact and run `Folio.exe` from it.

## Library

- Use **Import** to add files or whole folders, or drag them into the window. Folio copies originals into its library at `%APPDATA%\Luma\Library\Media` by default.
- **Library settings** shows the current location, media size, cache size, and free space. **Move library…** verifies copied files before switching to the new location.
- When upgrading a legacy library that links to originals, Folio copies any originals it can access. Reconnect a missing source drive and use **Copy existing originals** to finish.
- Expand the sidebar to browse folders and create collections. Use a card's menu to add media to collections or edit tags.
- Press `Ctrl+K` to search and `Ctrl+O` to choose files. Filter by year, month, date range, tag, or folder. Capture-date sorting uses image metadata where available. Folio offers to skip exact duplicates during import.
- In the viewer, double-click to zoom toward the pointer or return to fit. Scroll to zoom and drag with the left mouse button to pan. Arrow keys move between photos. Folio respects Windows' reduced-motion setting.
- **Delete photo** moves the library copy to **Recently deleted**, shown as **Deleted** in the sidebar. Restore photos to their previous folders and collections or send them to the Windows Recycle Bin.
- **Select** enables batch actions. Use `Shift`-click to select a range or `Ctrl+A` for all photos in the current view. The selection bar moves photos, adds them to a collection, or deletes them. `Ctrl+Z` undoes the last batch move.
- On Windows 11, the window uses system Acrylic. Its appearance depends on the desktop and the Windows transparency setting. The web preview uses a blurred landscape.
- Click or drag the theme switch beside **Import**. With the switch focused, the arrow keys choose dark or light. Your choice is saved.
- Click the first-launch greeting to open the tour, or choose **Skip** to go straight to the library. To replay it, close Folio and start it with `Folio.exe --intro`. The tour uses the gallery theme, which initially follows Windows.
- Choose English, Russian, or Simplified Chinese during onboarding or through the globe button.

## Back up or move a library

Choose **Import → Create backup…** and select a destination. The resulting `Folio-…` folder contains originals, external audio, subtitles, collections, favorites, and viewing history. Copy the entire folder to another drive or computer.

In **Library settings**, choose a backup destination and a daily or weekly schedule. Automatic backups run while Folio is open. The settings show the last successful automatic backup.

On the new computer, choose **Import → Restore from backup…** and select the `Folio-…` folder. Folio verifies checksums in newer backups and merges their contents into the current library.

## Editor and wallpaper

- Open a photo or video and choose **Edit** to crop, rotate, or adjust brightness, contrast, saturation, and sharpness. Use **Original** to compare with the source.
- Photo adjustments update as you drag the sliders. Additional controls cover exposure, shadows, highlights, and warmth. The **Crop** tab supports horizontal and vertical flips.
- For video, use **Trim** to set the start and end. Preview the selected range with adjustments applied.
- **Save copy** adds a new file beside the original in the library. Photos are exported as PNG and videos as MP4 with embedded audio.
- **Set as wallpaper** is available from a photo card's menu and from the viewer. Edited copies work as wallpaper too.

## Player

Open **Audio tracks** or **Subtitles** in the player. MKV playback supports embedded audio and text subtitle tracks.

To match external tracks automatically, import the parent folder containing the video, subtitle, and audio subfolders. Folio matches tracks by title, episode number, and season. Dubs from separate subfolders appear under those folder names. For videos already in the library, choose **Import → Refresh the library**. Use the player menus to attach tracks manually when file names are ambiguous.

**Series** groups numbered episodes into seasons and remembers playback position, audio, and subtitles. Mark episodes as watched from the episode list. **Save frame** adds a PNG beside the video in the library.

External subtitles support SRT, ASS, SSA, and VTT. External audio supports formats including MKA, FLAC, AAC, MP3, WAV, and AC3. When conversion is needed, Folio uses FFmpeg to stream video at up to 1080p with stereo audio.

Press `Space` to play or pause, the arrow keys to seek by five seconds, `F` for fullscreen, and `M` to mute.

## Development

```powershell
npm.cmd ci
npm.cmd start
npm.cmd test
npm.cmd run test:ui
npm.cmd run package:win
npm.cmd run package:win -- --installer
```

Use `npm.cmd run dev` for the browser preview. Desktop development requires FFmpeg and FFprobe on `PATH` or in the directory set by `LUMA_FFMPEG_DIR`. Both are bundled with the portable build.

Building the installer requires Inno Setup. Set `FOLIO_ISCC_PATH` to the path to `ISCC.exe` if it is installed in a custom location. The installer defaults to `%LOCALAPPDATA%\Programs\Folio`. The library profile is stored separately. For signed builds, set `FOLIO_SIGN_CERT_THUMBPRINT` and pass `--require-signing` alongside `--installer`.

The private test builds use FFmpeg 9.0.2 Essentials from Gyan. The build version and configuration are in `resources/ffmpeg/FFmpeg.txt` alongside the GPLv3 license. The [FFmpeg source archive](https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz) contains upstream version 9.0.2. Prepare the complete corresponding source for the bundled build and its libraries before distributing the installer publicly.

The demo images in `public/demo` and the coastal backdrop in `public/coast.jpg` were generated with ImageGen. The demo videos and GIFs were assembled from these images.
