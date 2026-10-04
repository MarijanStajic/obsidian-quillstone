# QuillStone

Handwritten sheets for [Obsidian](https://obsidian.md): draw with a stylus or mouse, on multi-page sheets stored as lightweight, diffable `.draw` files — with live previews embedded right in your notes.

## Features

- **Freehand drawing** — pen and highlighter, with pencil-pressure sensitivity and adjustable size. A toolbar toggle switches the pen to a dashed line, for boundaries, cut lines, or anything meant to stand out from regular ink; the setting carries over to the next stroke, never changing one already drawn.
- **Shapes** — rectangle, ellipse, triangle, line, and arrow, drawn by dragging with the shape palette. Holding a freehand stroke still also auto-recognizes it: closed loops become a clean circle, square/rectangle, equilateral or isosceles triangle, star, or regular/irregular polygon; open strokes with a bend (a chevron, an angled arrow, a zigzag) become a clean multi-segment line. Holding still mid-stroke straightens it; holding still again — without lifting the pen — locks that segment as a sharp corner and starts the next one, so a hand-drawn 90° angle (or any multi-sided outline) comes out as clean straight edges meeting at a point, not a diagonal cutting the corner.
- **Text boxes** — click with the text tool for a box that hugs what you type, or drag out a specific width to control wrapping; text alignment (left/center/right/justify), font (sans-serif, serif, monospace, handwritten), and a real pixel-based font size field. Click an existing box with the text tool (or double-click with any other tool) to edit its text, color, alignment, font, and size again. Resizing works two ways, on purpose: dragging the selection handles (cursor/lasso, outside editing) scales the font along with the box, like resizing a shape; dragging the dedicated handle on the box's bottom-right corner while actively typing only reflows the text into the new width, leaving the font size untouched.
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
- **Undo/redo**, per-page color palettes with recently-used colors, light/dark theme support.

## Usage

- Create a new sheet from the command palette (`QuillStone: New sheet`) or by right-clicking a folder/note.
- Import an existing PDF as a new sheet, or append its pages to a sheet you already have open.
- Click a link inside an imported PDF with the cursor (`c`) or hand (`h`) tool to follow it. Sheets imported before version 1.2.0 have no links stored: re-import the PDF to pick them up.
- Embed a sheet in any note with `![[sheet.draw]]`.

## File format

A sheet is saved as a `.draw` file: plain JSON, one entry per page, each stroke stored as a list of points rather than a rasterized image — small, readable, and diffable in Git.

## Platform notes

QuillStone works fully on Obsidian desktop. On mobile, drawing, shapes, images, and PDF import/export all work; copying/pasting between sheets falls back to the browser's clipboard API, which — depending on the mobile platform's permissions — may be less reliable than on desktop.

## License

[MIT](LICENSE) © 2026 Marijan Stajic
