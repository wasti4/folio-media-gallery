# Releasing Folio

## Checklist

1. Set the version with `npm version x.y.z --no-git-tag-version`.
2. Run `npm test` and `npm run test:ui`.
3. Build with `npm run package:win -- --installer`. Add `--require-signing` and set `FOLIO_SIGN_CERT_THUMBPRINT` for a signed installer.
4. Smoke-test first launch, an update over an existing library, external audio and subtitles, and unlocking and editing inside the private folder. Test a clean Windows 10 installation before claiming Windows 10 support.
5. Zip the portable folder as `Folio-x.y.z-portable.zip`, publish both files on GitHub Releases, and list their SHA-256 checksums in the release notes.

## License and FFmpeg

Folio's source code is released under the [MIT License](../LICENSE).

The Windows builds bundle FFmpeg 9.0.2 Essentials from Gyan as a separate executable. FFmpeg in that configuration is licensed under the GPLv3: the license text ships in `resources/ffmpeg/` together with `FFmpeg.txt`, which records the build version and configuration. The matching upstream source is the [FFmpeg 9.0.2 release archive](https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz). Keep these notices with every distributed package and link the corresponding source from each release. See the [FFmpeg legal page](https://www.ffmpeg.org/legal.html).

## macOS

The renderer and most of the desktop code use cross-platform Electron and Node APIs, but the installer, window backdrop and wallpaper integration are Windows-specific. A macOS release needs native builds for Apple silicon and Intel, a compatible FFmpeg and FFprobe, macOS window and wallpaper integration, and Developer ID signing with notarization.
