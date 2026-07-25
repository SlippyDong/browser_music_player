# Music Player PWA

A small, installable Progressive Web App for playing local music files in the browser and managing saved playlists.

**Table of contents**
- Overview
- Features
- Included files
- Prerequisites
- Install & run (local)
- Usage
- Saved-playlist details
- Development
- Contributing & license

**Overview**

Music Player PWA is a lightweight client-side music player that runs in modern browsers (Chromium-based / Edge / Chrome). It is intended for local playback of audio files and for creating, saving, and restoring playlists using the Web File System Access API plus IndexedDB.

**Features**

- **Installable PWA**: Add the app to your system via the browser's Install prompt for an app-like experience.
- **Offline app shell**: service-worker.js caches the app shell so the installed app launches offline.
- **Saved playlists**: Create, open, rename, update, save-as, and delete named playlists persisted in IndexedDB.
- **File & folder handles**: Stores file or folder handles (when the browser grants them) so playlists can be reopened without re-picking files.
- **Multiple audio formats**: Supports common local audio files (mp3, wav, flac) via file associations and in-browser playback.
- **Drag & drop / picker**: Add tracks by file picker or drag-and-drop; fallback picker support is provided when handle persistence isn't available.
- **Metadata re-read on open**: The app reads metadata (title, artist, duration, etc.) from files at playlist open time rather than storing it in the DB.

Additional functionality

- **Edit & save metadata**: Update Title, Artist, Album, Year, Track, Genre and Comment directly from the playlist UI. Changes are written back to the file when the browser and file format support it.
- **Accurate bitrate display**: Shows accurate bitrates for FLAC, WAV and MP3 files.
- **Precise seeking**: Full-width seek slider with a hover tooltip showing the current timestamp for precise seeking.
- **Playback controls**: Shuffle, Repeat One, Repeat All, volume control, and playback speed adjustments.
- **Playlist management**: Save multiple playlists, select them from a dropdown, rename, update, and delete playlists; deleting a playlist never deletes your audio files.
- **Privacy-first**: No cookies or tracking data; all playlist data is stored locally in the browser's IndexedDB.

**Included files**

- [index.html](index.html) — application markup
- [styles.css](styles.css) — styling
- [app.js](app.js) — player logic, UI, PWA integration, and file handling
- [playlist-db.js](playlist-db.js) — IndexedDB playlist layer
- [manifest.webmanifest](manifest.webmanifest) — PWA metadata and file associations
- [service-worker.js](service-worker.js) — offline caching
- [start-local.bat](start-local.bat) / [start-local.ps1](start-local.ps1) — optional localhost launcher
- [icons/](icons/) — app and file-handler icons

**Install & run (local)**

PWAs must be served from HTTPS or `localhost` to be installable and to use the File System Access API reliably. For quick local testing on Windows:

1. Extract the project.
2. Double-click `start-local.bat`, or run the Python server from the project root:

```powershell
py -m http.server 8000
```

3. Open `http://localhost:8000/` in Edge or Chrome.

4. Click **Install app** in the UI or use the browser menu to install.

The local server is only needed for installation and updates; the installed app will use the cached app shell for offline launches.

Note on standalone HTML vs secure hosts

- You can open `index.html` directly from the filesystem for basic in-browser playback, but that `file://` context is not a secure context and cannot use the File System Access API or persistent handles. As a result, saving and reopening playlists (persistent file access) will not work when opening the file directly.
- Serving the app from `localhost` or `https` provides a secure context and enables full file access. Installing the PWA is optional — running the app in a browser tab served over `localhost` or `https` is sufficient to grant the permissions needed to save and open playlists. Installing the PWA only provides an app-like shortcut and offline app-shell convenience.

**Usage**

- Add tracks using the file picker, drag-and-drop, or by selecting a folder. The UI shows playlist order and simple playback controls (play/pause, next, previous, seek).
- Save the current playlist to IndexedDB under a name for later recall.
- If the browser granted persistent handles, playlists reopen automatically with full access to files. If not, the browser may prompt you to reauthorize access when opening a saved playlist.
- The app never deletes user audio files — deleting a playlist only removes the playlist entry from the database.

**Saved-playlist details**

The DB stores playlist identity and file references only:

- Playlist name and track order
- File or root-directory handles (when available)
- Filenames and relative paths

It does not store audio metadata (duration, bitrate, tags). Those are read from the files each time for accuracy.

**Development**

- Open the project folder and run the local server as described above.
- Edit [app.js](app.js) and [playlist-db.js](playlist-db.js) to change player behavior or the DB schema.

**Contributing & License**

Contributions are welcome. Open an issue or submit a PR with improvements or bug fixes.

This project is open source and licensed under the MIT License.

- **License**: MIT
- **Copyright**: Slippydong

See the included `LICENSE` file for the full text.

**Prerequisites**

- A modern Chromium-based browser (Microsoft Edge or Google Chrome) is required for PWA installation and the best File System Access API support.
- Python 3 (recommended) for a quick local server used during installation and testing. Alternatively, use the provided `start-local.bat` on Windows.

Quick check & install (Windows):

```powershell
py --version    # or `python --version` - confirms Python is installed
py -m http.server 8000   # run a local server from the project root
```

If `py`/`python` is not available, install Python from https://www.python.org/downloads/ or via the Microsoft Store. The `start-local.bat` file provides a one-click server start on Windows.

---
