# Wayfinder

A small Tauri 2 desktop palette for files, folders, apps, webpages, text, and nested shortcut rings.

## Run

```powershell
npm install
npm run tauri dev
```

Stopping `npm run tauri dev` also exits its development app and removes its tray icon. Packaged builds continue to run in the tray until you choose **Quit**.

On Windows, Wayfinder stores shortcuts, appearance settings, and the palette hotkey in `%APPDATA%\app.wayfinder.palette`. On startup it imports any missing files from the previous app data folder.

Drag files or folders from Explorer onto the circular window. The palette saves their paths in its app data directory and leaves the originals untouched. Open **Settings** from the tray menu to enter edit mode. Click a tile to open the **Edit tile** tab, where you can edit it or choose **Remove tile**. You can also drag a tile to another position in its ring. Up to 12 shortcuts fit on each ring.

Selecting a shortcut hides the floating palette immediately. The spaces between occupied ring slices are transparent.
On Windows, selecting a running app brings it forward. If it was already in front when you opened the palette, selecting it minimizes that window.
Each occupied slice has its own border. The center shows the active workspace icon. Hover over it to see the workspace name.
Edit mode opens a settings window beside the palette. The **Tiles** tab comes first: drag Submenu, Text, Folder, Webpage, or App onto a ring. Existing tiles move aside and a dashed, empty slot shows where the new tile will land. Hover over a submenu to reveal its outer ring; a submenu can contain another submenu, for up to three rings total. Empty submenus show a dashed target in edit mode and accept dropped tiles and files. Removing a submenu also removes its contents. Text, Folder, Webpage, and App open a form before the tile is saved. The App form lists Start Menu apps, accepts an `.exe` or `.lnk` path, and has a Browse button; Folder has a folder picker. Text copies its saved content to the clipboard when selected. Webpage opens its URL, and App launches its target. You can also click a tile type to append it to the root ring.

The **Appearance** tab has sliders for tile size, text size, root shell inner radius, border thickness, tile corner radius, tile padding, and submenu padding. Tile size changes the palette smoothly while the settings window stays in place. Tile corner radius rounds the tile edges, with 0 keeping sharp corners. Tile padding controls the gap along both sides of each tile; at 0, neighboring tile edges touch. Submenu padding controls the space between rings. Changes preview as you drag and are saved in the app data directory. Closing the settings window exits edit mode.

Press **Ctrl+Space** from anywhere to show or hide the palette. Closing the palette window hides it so the shortcut keeps working. Right-click the tray icon for **Show palette**, **Settings**, and **Quit**.

The palette currently opens as a centered window. Macros are future work.
