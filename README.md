# QuillStone

Handwritten sheets for [Obsidian](https://obsidian.md): draw with a stylus or mouse, on multi-page sheets stored as lightweight, diffable `.draw` files — with live previews embedded right in your notes.

## Features

- **Freehand drawing** — pen and highlighter, with pencil-pressure sensitivity and adjustable size.
- **Shapes** — rectangle, ellipse, triangle, line, and arrow, drawn by dragging or auto-recognized from a held freehand stroke.
- **Eraser** — by stroke or by zone.
- **Selection tool** — move, resize, rotate, recolor, restack, duplicate, cut/copy/paste (including across sheets and pages), lock elements in place.
- **Images** — paste, drag-and-drop, or insert from a file picker; crop after insertion. Screen-capture a rectangular area of the page into a new image.
- **PDF import** — bring in a PDF as a background you can draw over, one page of the PDF per page of the sheet. Works with large, multi-hundred-page PDFs (the PDF is stored once, privately, never duplicated per page).
- **PDF export** — export any sheet back to a real PDF file, at print resolution.
- **Multi-page sheets** — add, delete, reorder, and move pages; each page has its own background, density, paper format, and orientation.
- **Paper formats** — A3, A4, A5, Letter, Legal, in portrait or landscape.
- **Backgrounds** — blank, grid, ruled lines, dots, Seyès (French ruled), music staff, isometric — each with three density levels.
- **Embedded preview** — `![[sheet.draw]]` renders a live, paginated thumbnail directly inside your notes, expandable and clickable to open the full sheet.
- **Laser pointer** — a temporary, non-persisted pointer for presenting without marking up the page.
- **Undo/redo**, per-page color palettes with recently-used colors, light/dark theme support.

## Installation

This plugin is not yet on the Obsidian community plugin list. Until then, install it manually:

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases/latest).
2. Create a folder named `quillstone` inside your vault's `.obsidian/plugins/` directory.
3. Copy the three files into that folder.
4. Reload Obsidian, then enable **QuillStone** in Settings → Community plugins.

Or install it via [BRAT](https://github.com/TfTHacker/obsidian42-brat) by pointing it at this repository.

## Usage

- Create a new sheet from the command palette (`QuillStone: New sheet`) or by right-clicking a folder/note.
- Import an existing PDF as a new sheet, or append its pages to a sheet you already have open.
- Embed a sheet in any note with `![[sheet.draw]]`.

## File format

A sheet is saved as a `.draw` file: plain JSON, one entry per page, each stroke stored as a list of points rather than a rasterized image — small, readable, and diffable in Git.

## Platform notes

QuillStone works fully on Obsidian desktop. On mobile, drawing, shapes, images, and PDF import/export all work; copying/pasting between sheets falls back to the browser's clipboard API, which — depending on the mobile platform's permissions — may be less reliable than on desktop.

## License

[MIT](LICENSE) © 2026 Marijan Stajic
