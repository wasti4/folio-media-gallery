# Changelog

Downloads for every version are on the [Releases page](https://github.com/wasti4/folio-media-gallery/releases).

## Unreleased

- **A calmer interface.** Lighter type weights and slightly larger small text, sentence-case labels instead of spaced capitals, steadier spacing, and no glows or springy motion. Cards no longer jump or zoom on hover.
- **List view shows file details.** Format, pixel size or running time, and file size line up in columns.
- **Less noise on cards.** Photos lose the format badge; videos and GIFs keep theirs.
- **Fixes.** In the private folder the window buttons stay on the right. Recently deleted cards are as wide as the rest and show short dates. Batch editing has a labelled **Edit** button in the selection bar.
- **Smaller download.** The build ships Chromium resources only for the three languages Folio speaks.

## 1.10.0 · 2026-11-24

- **Updates from inside Folio.** Folio checks GitHub once a day and offers new versions in **Settings → Updates**. The installer is checked against the SHA-256 digest GitHub publishes for it, runs once Folio has saved its library, and starts Folio again. The check sends nothing about you or your library and can be turned off. Portable copies link to the release page.
- **Watched folders.** New photos and videos from folders you choose come in on their own once they have finished writing. Exact duplicates are skipped, and what you deleted in Folio stays deleted.
- **Batch editing.** One look, rotation and set of adjustments for many photos at once, each saved as its own copy.
- **Settings.** Library settings are now simply **Settings**, with a mark on the button when an update is waiting.

Builds of 1.9.0 and earlier can't update themselves, so install 1.10.0 by hand once.

## 1.9.0 · 2026-11-23

The first public release, under the MIT License.

- **New photo editor.** Seven looks with a strength slider, a live histogram, grouped light, color and detail controls, undo and redo for every step, and hold-to-compare with the original.
- **Private folder.** An encrypted vault (AES-256-GCM, scrypt) that locks itself when you leave it, minimize Folio or lock Windows.
- **Folders, your way.** Delete a folder together with its photos, and empty Recently deleted in one step.
- **Profile move.** Earlier private builds kept their profile in `%APPDATA%\Luma`; Folio moves it to `%APPDATA%\Folio` on first launch.

Versions before 1.9.0 were private test builds and were never published.
