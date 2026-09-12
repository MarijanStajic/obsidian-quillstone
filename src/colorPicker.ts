/**
 * Sélecteur de couleur maison, en remplacement de `<input type="color">` :
 * dans Electron (donc dans Obsidian desktop), ce contrôle natif valide la
 * couleur dès le premier clic sur la fenêtre système, ce qui empêche
 * d'explorer les teintes avant de choisir. Ce module ne dépend pas
 * d'Obsidian : c'est un composant DOM autonome, réutilisé à l'identique pour
 * le sélecteur libre de la barre d'outils, le remplacement d'une pastille de
 * palette (view.ts) et l'éditeur de palettes de la page de réglages
 * (settings.ts) — un seul composant, trois usages.
 */

const SQUARE_SIZE = 160;
const HUE_WIDTH = 16;
const HUE_HEIGHT = SQUARE_SIZE;
const KEY_STEP = 1;
const KEY_STEP_FAST = 10;

export interface ColorPickerOptions {
	/** Élément sous lequel positionner le panneau (bouton ou pastille cliqués). */
	anchor: HTMLElement;
	initialColor: string;
	/**
	 * Appelé en continu pendant un glissement dans le carré ou la bande de
	 * teinte (ou une saisie hexadécimale valide) : c'est l'aperçu en direct,
	 * jamais persisté. Absent si l'appelant n'a rien à prévisualiser en direct
	 * (page de réglages, qui n'a pas d'« outil actif » à faire varier).
	 */
	onPreview?: (color: string) => void;
	/** Appelé une seule fois, à la validation (bouton Valider ou touche Entrée). */
	onCommit: (color: string) => void;
	/** Appelé à l'annulation (bouton Annuler, Échap, ou clic hors du panneau) — doit restaurer l'état précédent l'aperçu en direct. */
	onCancel?: () => void;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function normalizeHex(raw: string): string | null {
	const trimmed = raw.trim();
	const match = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(trimmed);
	if (!match) return null;
	let hex = match[1];
	if (hex.length === 3) {
		hex = hex
			.split("")
			.map((c) => c + c)
			.join("");
	}
	return `#${hex.toLowerCase()}`;
}

function hexToRgb(hex: string): [number, number, number] {
	const n = parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
	return `#${[r, g, b]
		.map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, "0"))
		.join("")}`;
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const d = max - min;
	let h = 0;
	if (d !== 0) {
		if (max === rn) h = ((gn - bn) / d) % 6;
		else if (max === gn) h = (bn - rn) / d + 2;
		else h = (rn - gn) / d + 4;
		h *= 60;
		if (h < 0) h += 360;
	}
	const s = max === 0 ? 0 : d / max;
	return { h, s, v: max };
}

/** Dessine le carré saturation/luminosité pour une teinte donnée : blanc à gauche vers transparent, opaque en bas vers noir, par-dessus un aplat de la teinte — trois passes de dégradés *sur le canvas*, pas en CSS, pour pouvoir relire la couleur exacte au pointeur (getImageData) sans reformuler la conversion HSV→RGB. */
function paintSquare(ctx: CanvasRenderingContext2D, w: number, h: number, hue: number): void {
	ctx.fillStyle = `hsl(${hue}, 100%, 50%)`;
	ctx.fillRect(0, 0, w, h);

	const whiteGrad = ctx.createLinearGradient(0, 0, w, 0);
	whiteGrad.addColorStop(0, "#ffffff");
	whiteGrad.addColorStop(1, "rgba(255,255,255,0)");
	ctx.fillStyle = whiteGrad;
	ctx.fillRect(0, 0, w, h);

	const blackGrad = ctx.createLinearGradient(0, 0, 0, h);
	blackGrad.addColorStop(0, "rgba(0,0,0,0)");
	blackGrad.addColorStop(1, "#000000");
	ctx.fillStyle = blackGrad;
	ctx.fillRect(0, 0, w, h);
}

/** Bande de teinte verticale, spectre complet 0→360°, dessinée sur canvas pour la même raison que paintSquare. */
function paintHueStrip(ctx: CanvasRenderingContext2D, w: number, h: number): void {
	const grad = ctx.createLinearGradient(0, 0, 0, h);
	for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, `hsl(${i * 60}, 100%, 50%)`);
	ctx.fillStyle = grad;
	ctx.fillRect(0, 0, w, h);
}

/** canvas.width/height sont en pixels d'écran (devicePixelRatio compris) ; getImageData lit donc aussi en pixels d'écran, d'où la conversion depuis des coordonnées CSS à chaque échantillonnage. */
function setupHiDPICanvas(canvas: HTMLCanvasElement, cssW: number, cssH: number): CanvasRenderingContext2D {
	const dpr = window.devicePixelRatio || 1;
	canvas.width = Math.round(cssW * dpr);
	canvas.height = Math.round(cssH * dpr);
	canvas.style.width = `${cssW}px`;
	canvas.style.height = `${cssH}px`;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("Canvas 2D indisponible");
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	return ctx;
}

function samplePixel(ctx: CanvasRenderingContext2D, cssX: number, cssY: number): [number, number, number] {
	const dpr = window.devicePixelRatio || 1;
	const px = clamp(Math.round(cssX * dpr), 0, ctx.canvas.width - 1);
	const py = clamp(Math.round(cssY * dpr), 0, ctx.canvas.height - 1);
	const data = ctx.getImageData(px, py, 1, 1).data;
	return [data[0], data[1], data[2]];
}

/** Un seul panneau ouvert à la fois : en ouvrir un nouveau annule proprement (onCancel compris) celui déjà ouvert, plutôt que de le laisser en aperçu non validé. */
let closeActivePicker: (() => void) | null = null;

export function openColorPicker(options: ColorPickerOptions): void {
	closeActivePicker?.();
	closeActivePicker = null;

	const { anchor, onPreview, onCommit, onCancel } = options;
	const initial = normalizeHex(options.initialColor) ?? "#000000";

	let workingColor = initial;
	const [ir, ig, ib] = hexToRgb(initial);
	const initialHsv = rgbToHsv(ir, ig, ib);
	let hue = initialHsv.h;
	let squareX = initialHsv.s * SQUARE_SIZE;
	let squareY = (1 - initialHsv.v) * SQUARE_SIZE;

	const panel = document.createElement("div");
	panel.className = "quillstone-picker-panel";
	panel.setAttribute("role", "dialog");
	panel.setAttribute("aria-label", "Color picker");

	const area = panel.createDiv({ cls: "quillstone-picker-area" });

	const squareWrap = area.createDiv({ cls: "quillstone-picker-square-wrap" });
	squareWrap.tabIndex = 0;
	squareWrap.setAttribute("role", "slider");
	squareWrap.setAttribute("aria-label", "Saturation and brightness");
	const squareCanvas = squareWrap.createEl("canvas", { cls: "quillstone-picker-square" });
	const squareCursor = squareWrap.createDiv({ cls: "quillstone-picker-square-cursor" });
	const squareCtx = setupHiDPICanvas(squareCanvas, SQUARE_SIZE, SQUARE_SIZE);

	const hueWrap = area.createDiv({ cls: "quillstone-picker-hue-wrap" });
	hueWrap.tabIndex = 0;
	hueWrap.setAttribute("role", "slider");
	hueWrap.setAttribute("aria-label", "Hue");
	const hueCanvas = hueWrap.createEl("canvas", { cls: "quillstone-picker-hue" });
	const hueCursor = hueWrap.createDiv({ cls: "quillstone-picker-hue-cursor" });
	const hueCtx = setupHiDPICanvas(hueCanvas, HUE_WIDTH, HUE_HEIGHT);

	const row = panel.createDiv({ cls: "quillstone-picker-row" });
	const hexInput = row.createEl("input", { cls: "quillstone-picker-hex" });
	hexInput.type = "text";
	hexInput.spellcheck = false;
	hexInput.value = workingColor;
	hexInput.setAttribute("aria-label", "Color as a hex value");

	const preview = row.createDiv({ cls: "quillstone-picker-preview" });
	const previewCurrent = preview.createDiv({ cls: "quillstone-picker-preview-current" });
	previewCurrent.setAttribute("aria-label", "Selected color");
	const previewPrevious = preview.createDiv({ cls: "quillstone-picker-preview-previous" });
	previewPrevious.setAttribute("aria-label", "Previous color");
	previewPrevious.style.backgroundColor = initial;

	const actions = panel.createDiv({ cls: "quillstone-picker-actions" });
	const cancelBtn = actions.createEl("button", { cls: "quillstone-picker-cancel", text: "Cancel" });
	cancelBtn.type = "button";
	const confirmBtn = actions.createEl("button", { cls: "quillstone-picker-confirm mod-cta", text: "OK" });
	confirmBtn.type = "button";

	paintSquare(squareCtx, SQUARE_SIZE, SQUARE_SIZE, hue);
	paintHueStrip(hueCtx, HUE_WIDTH, HUE_HEIGHT);

	function updateCursors(): void {
		squareCursor.style.left = `${squareX}px`;
		squareCursor.style.top = `${squareY}px`;
		hueCursor.style.top = `${(hue / 360) * HUE_HEIGHT}px`;
	}

	function applyWorkingColor(color: string, live: boolean): void {
		workingColor = color;
		hexInput.value = color;
		previewCurrent.style.backgroundColor = color;
		updateCursors();
		if (live) onPreview?.(color);
	}

	function setFromSquare(cssX: number, cssY: number): void {
		squareX = clamp(cssX, 0, SQUARE_SIZE);
		squareY = clamp(cssY, 0, SQUARE_SIZE);
		const [r, g, b] = samplePixel(squareCtx, squareX, squareY);
		applyWorkingColor(rgbToHex(r, g, b), true);
	}

	function setFromHue(cssY: number): void {
		const y = clamp(cssY, 0, HUE_HEIGHT);
		const [r, g, b] = samplePixel(hueCtx, HUE_WIDTH / 2, y);
		hue = rgbToHsv(r, g, b).h;
		paintSquare(squareCtx, SQUARE_SIZE, SQUARE_SIZE, hue);
		const [sr, sg, sb] = samplePixel(squareCtx, squareX, squareY);
		applyWorkingColor(rgbToHex(sr, sg, sb), true);
	}

	function bindDrag(el: HTMLElement, onMove: (cssX: number, cssY: number) => void): void {
		el.addEventListener("pointerdown", (evt) => {
			evt.preventDefault();
			el.setPointerCapture(evt.pointerId);
			el.focus();
			const rect = el.getBoundingClientRect();
			onMove(evt.clientX - rect.left, evt.clientY - rect.top);

			const move = (e2: PointerEvent): void => {
				const r = el.getBoundingClientRect();
				onMove(e2.clientX - r.left, e2.clientY - r.top);
			};
			const stop = (): void => {
				el.removeEventListener("pointermove", move);
				el.removeEventListener("pointerup", stop);
				el.removeEventListener("pointercancel", stop);
			};
			el.addEventListener("pointermove", move);
			el.addEventListener("pointerup", stop);
			el.addEventListener("pointercancel", stop);
		});
	}

	bindDrag(squareWrap, (x, y) => setFromSquare(x, y));
	bindDrag(hueWrap, (_x, y) => setFromHue(y));

	squareWrap.addEventListener("keydown", (evt) => {
		const step = evt.shiftKey ? KEY_STEP_FAST : KEY_STEP;
		let dx = 0;
		let dy = 0;
		if (evt.key === "ArrowLeft") dx = -step;
		else if (evt.key === "ArrowRight") dx = step;
		else if (evt.key === "ArrowUp") dy = -step;
		else if (evt.key === "ArrowDown") dy = step;
		else return;
		evt.preventDefault();
		setFromSquare(squareX + dx, squareY + dy);
	});

	hueWrap.addEventListener("keydown", (evt) => {
		const step = evt.shiftKey ? KEY_STEP_FAST : KEY_STEP;
		let dy = 0;
		if (evt.key === "ArrowUp") dy = -step;
		else if (evt.key === "ArrowDown") dy = step;
		else return;
		evt.preventDefault();
		setFromHue((hue / 360) * HUE_HEIGHT + dy);
	});

	hexInput.addEventListener("input", () => {
		const normalized = normalizeHex(hexInput.value);
		if (!normalized) return; // saisie incomplète : on attend une valeur valide sans rien appliquer
		const [r, g, b] = hexToRgb(normalized);
		const hsv = rgbToHsv(r, g, b);
		hue = hsv.h;
		squareX = hsv.s * SQUARE_SIZE;
		squareY = (1 - hsv.v) * SQUARE_SIZE;
		paintSquare(squareCtx, SQUARE_SIZE, SQUARE_SIZE, hue);
		workingColor = normalized;
		previewCurrent.style.backgroundColor = normalized;
		updateCursors();
		onPreview?.(normalized);
		// hexInput.value n'est pas réécrit ici : ça déplacerait le curseur de saisie en pleine frappe.
	});

	function cleanup(): void {
		document.removeEventListener("pointerdown", onDocPointerDown, true);
		panel.remove();
		if (closeActivePicker === cleanupAndCancel) closeActivePicker = null;
	}

	function commitAndClose(): void {
		cleanup();
		onCommit(workingColor);
	}

	function cancelAndClose(): void {
		cleanup();
		onCancel?.();
	}

	// Alias stable : sert de jeton d'identité pour closeActivePicker (voir cleanup), et c'est bien une annulation qu'un panneau supplanté doit subir, pas une validation silencieuse.
	const cleanupAndCancel = cancelAndClose;
	closeActivePicker = cleanupAndCancel;

	const onDocPointerDown = (evt: PointerEvent): void => {
		if (panel.contains(evt.target as Node)) return;
		cancelAndClose();
	};
	document.addEventListener("pointerdown", onDocPointerDown, true);

	panel.addEventListener("keydown", (evt) => {
		if (evt.key === "Enter") {
			evt.preventDefault();
			commitAndClose();
		} else if (evt.key === "Escape") {
			evt.preventDefault();
			cancelAndClose();
		}
	});

	confirmBtn.addEventListener("click", () => commitAndClose());
	cancelBtn.addEventListener("click", () => cancelAndClose());

	updateCursors();
	document.body.appendChild(panel);
	positionPanel(panel, anchor);
	squareWrap.focus();
}

/** Sous le bouton par défaut ; se replie au-dessus s'il déborderait en bas, et se décale horizontalement s'il déborderait sur le côté — jamais hors de la fenêtre. */
function positionPanel(panel: HTMLElement, anchor: HTMLElement): void {
	const anchorRect = anchor.getBoundingClientRect();
	const panelRect = panel.getBoundingClientRect();
	const margin = 6;

	let left = anchorRect.left;
	if (left + panelRect.width > window.innerWidth - margin) {
		left = window.innerWidth - panelRect.width - margin;
	}
	left = Math.max(margin, left);

	let top = anchorRect.bottom + margin;
	if (top + panelRect.height > window.innerHeight - margin) {
		top = anchorRect.top - panelRect.height - margin;
	}
	if (top < margin) top = margin;

	panel.style.left = `${left}px`;
	panel.style.top = `${top}px`;
}
