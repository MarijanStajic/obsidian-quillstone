# QuillStone

Handwritten sheets for [Obsidian](https://obsidian.md): draw with a stylus or mouse, on multi-page sheets stored as lightweight, diffable `.draw` files — with live previews embedded right in your notes.

## Features

- **Freehand drawing** — pen and highlighter, with pencil-pressure sensitivity and adjustable size. A toolbar toggle switches the pen to a dashed line, for boundaries, cut lines, or anything meant to stand out from regular ink; the setting carries over to the next stroke, never changing one already drawn.
- **Shapes** — rectangle, ellipse, triangle, line, and arrow, drawn by dragging with the shape palette. Holding a freehand stroke still also auto-recognizes it: closed loops become a clean circle, square/rectangle, equilateral or isosceles triangle, star, or regular/irregular polygon; open strokes with a bend (a chevron, an angled arrow, a zigzag) become a clean multi-segment line. Holding still mid-stroke straightens it at its real angle; keep holding still to snap it to the nearest 15°, and hold still again after moving — without lifting the pen — to lock a sharp corner and start the next segment, so a hand-drawn 90° angle (or any multi-sided outline) comes out as clean straight edges meeting at a point. Shapes recognized from a highlighter stroke stay translucent, like the highlighter itself.
- **Text boxes** — click with the text tool for a box that hugs what you type, or drag out a box whose height sets the font size; text alignment (left/center/right/justify), font (sans-serif, serif, monospace, handwritten), and a real pixel-based font size field. Several colors can live in the same box: select part of the text and pick a color. Click an existing box with the text tool (or double-click with any other tool) to edit it again. While typing, one handle resizes the box (the text reflows, its size stays), and the "A" handle next to it scales the text itself; outside editing, the selection handles scale the whole box like a shape. When you finish, the box shrinks to fit the text actually written.
- **Eraser** — by stroke or by zone.
- **Selection tool** — move, resize, rotate, recolor, restack, duplicate, cut/copy/paste (including across sheets and pages), lock elements in place.
- **Images** — paste, drag-and-drop, or insert from a file picker; crop after insertion. Screen-capture a rectangular area of the page into a new image.
- **PDF import** — bring in a PDF as a background you can draw over, one page of the PDF per page of the sheet. Works with large, multi-hundred-page PDFs (the PDF is stored once, privately, never duplicated per page).
- **Live PDF links** — an imported PDF keeps its clickable links: table-of-contents entries, cross-references, and footnote markers jump to the right page of the sheet, and web links open in your browser. Follow one with the cursor or hand tool (or a finger tap on a tablet); the pen, highlighter, and erasers keep drawing straight over a link, as usual.
- **PDF export** — export any sheet back to a real PDF file, at print resolution.
- **Multi-page sheets** — add, delete, reorder, and move pages; each page has its own background, density, paper format, and orientation.
- **Paper formats** — A3, A4, A5, Letter, Legal, in portrait or landscape.
- **Backgrounds** — blank, grid, ruled lines, dots, Seyès (French ruled), music staff, isometric — each with three density levels.
- **Embedded preview** — `![[sheet.draw]]` renders a live, paginated thumbnail directly inside your notes, expandable and clickable to open the full sheet.
- **Laser pointer** — a temporary, non-persisted pointer for presenting without marking up the page.
- **Collapsible toolbar** — hide it (button on its far right, or the `B` key) to give the sheet the full height. Tool tooltips show their keyboard shortcut.
- **Undo/redo**, per-page color palettes with recently-used colors, light/dark theme support.

## Usage

- Create a new sheet from the command palette (`QuillStone: Insert a drawing sheet`) or by right-clicking a folder/note.
- Import an existing PDF as a new sheet, or append its pages to a sheet you already have open.
- Click a link inside an imported PDF with the cursor (`c`) or hand (`h`) tool to follow it. Sheets imported before version 1.2.0 have no links stored: re-import the PDF to pick them up.
- Embed a sheet in any note with `![[sheet.draw]]`.

## File format

A sheet is saved as a `.draw` file: plain JSON, one entry per page, each stroke stored as a list of points rather than a rasterized image — small, readable, and diffable in Git.

## Keyboard shortcuts

Inside a sheet: `P` pen, `M` highlighter, `T` text, `E` eraser (zone), `D` eraser (whole stroke), `H` hand, `C` cursor, `L` lasso, `B` show/hide the toolbar, `Mod+Shift+]` / `Mod+Shift+[` bring the selection to front / send it to back. They never trigger while you are typing in a field. Every action is also an Obsidian command, so you can assign your own hotkeys in Settings → Hotkeys.

## Requirements

Obsidian 1.13 or later, on desktop or mobile. Older Obsidian versions keep receiving QuillStone 1.3.0.

## Privacy and permissions

- **No network access.** QuillStone never sends anything anywhere. The only outgoing action is opening a web link from an imported PDF in your browser, and only when you click it.
- **Clipboard.** Used only when you explicitly copy, cut, or paste (toolbar, context menu, or keyboard shortcut): copying writes the selected elements to the clipboard, pasting reads the clipboard to insert them — or an image copied from elsewhere. Nothing is read from the clipboard at any other time.
- **Vault files.** QuillStone reads and writes `.draw` files and the PDFs/images you import, only through Obsidian's own API.
- **No dynamic code.** The bundled PDF engine (pdf.js) has its code-generation paths removed at build time, so no code is ever generated or evaluated at runtime.

## Platform notes

QuillStone works fully on Obsidian desktop. On mobile, drawing, shapes, images, and PDF import/export all work; copying/pasting between sheets falls back to the browser's clipboard API, which — depending on the mobile platform's permissions — may be less reliable than on desktop.

## License

[MIT](LICENSE) © 2026 Marijan Stajic
