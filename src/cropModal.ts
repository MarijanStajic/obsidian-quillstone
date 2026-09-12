import { App, Modal, Setting } from "obsidian";
import type { ImageElement } from "./model";
import { intrinsicSize } from "./render";

/** Taille maximale (CSS px) de l'aperçu dans la modale — le bitmap source peut être bien plus grand (une page de PDF importée, voir ImageElement.pdfPage), inutile de l'afficher à sa pleine résolution pour tracer un rectangle. */
const MAX_PREVIEW_SIZE = 480;
/** Taille minimale (CSS px) du rectangle de rognage — sous ce seuil, les poignées se chevaucheraient et le résultat serait de toute façon inutilisable. */
const MIN_RECT_SIZE = 24;
/** Épaisseur (CSS px) de la zone cliquable d'une poignée, carrée, centrée sur le coin qu'elle contrôle. */
const HANDLE_SIZE = 12;

type Corner = "nw" | "ne" | "se" | "sw";
interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Modale de rognage d'une image ou d'une page de PDF importée (voir
 * ImageElement.crop, model.ts) — ouverte depuis le bouton « Rogner » de la
 * barre d'outils (voir view.ts:openCropDialog), pour l'unique image
 * actuellement sélectionnée. Travaille sur un aperçu redimensionné
 * (MAX_PREVIEW_SIZE), jamais sur le bitmap source à pleine résolution : le
 * rectangle de rognage est stocké en fractions (0..1) du cadre affiché ici,
 * qui correspondent exactement aux mêmes fractions du bitmap source quelle
 * que soit sa résolution réelle (voir la doc du champ, model.ts).
 */
export class CropImageModal extends Modal {
	private rect: Rect;
	private stageEl!: HTMLElement;
	private rectEl!: HTMLElement;
	private handleEls = new Map<Corner, HTMLElement>();
	private stageWidth = 0;
	private stageHeight = 0;
	private dragCleanup: (() => void) | null = null;

	constructor(
		app: App,
		private image: CanvasImageSource,
		private initialCrop: ImageElement["crop"] | null,
		private onApply: (crop: NonNullable<ImageElement["crop"]>) => void
	) {
		super(app);
		// Valeur jetable en unités CSS px du stage : sans objet, jamais lue
		// avant qu'onOpen() ne la remplace par le rectangle initial une fois
		// la taille du stage connue.
		this.rect = { x: 0, y: 0, width: 1, height: 1 };
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle("Crop image");

		const { width: naturalWidth, height: naturalHeight } = intrinsicSize(this.image);
		const scale = Math.min(1, MAX_PREVIEW_SIZE / naturalWidth, MAX_PREVIEW_SIZE / naturalHeight);
		this.stageWidth = Math.max(1, Math.round(naturalWidth * scale));
		this.stageHeight = Math.max(1, Math.round(naturalHeight * scale));

		this.stageEl = contentEl.createDiv({ cls: "quillstone-crop-stage" });
		this.stageEl.style.width = `${this.stageWidth}px`;
		this.stageEl.style.height = `${this.stageHeight}px`;

		const canvas = this.stageEl.createEl("canvas");
		canvas.width = this.stageWidth;
		canvas.height = this.stageHeight;
		canvas.style.width = `${this.stageWidth}px`;
		canvas.style.height = `${this.stageHeight}px`;
		const ctx = canvas.getContext("2d");
		ctx?.drawImage(this.image, 0, 0, this.stageWidth, this.stageHeight);

		this.rectEl = this.stageEl.createDiv({ cls: "quillstone-crop-rect" });
		this.rectEl.addEventListener("pointerdown", (evt) => this.startDrag(evt, "move"));

		for (const corner of ["nw", "ne", "se", "sw"] as Corner[]) {
			const handle = this.rectEl.createDiv({ cls: `quillstone-crop-handle quillstone-crop-handle-${corner}` });
			handle.addEventListener("pointerdown", (evt) => this.startDrag(evt, corner));
			this.handleEls.set(corner, handle);
		}

		const initial = this.initialCrop ?? { x: 0, y: 0, width: 1, height: 1 };
		this.setRect({
			x: initial.x * this.stageWidth,
			y: initial.y * this.stageHeight,
			width: initial.width * this.stageWidth,
			height: initial.height * this.stageHeight,
		});

		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText("Reset").onClick(() => this.resetRect()))
			.addButton((btn) =>
				btn
					.setButtonText("Crop")
					.setCta()
					.onClick(() => this.apply())
			)
			.addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()));
	}

	private resetRect(): void {
		this.setRect({ x: 0, y: 0, width: this.stageWidth, height: this.stageHeight });
	}

	/** Pose `rect` (repère du stage, CSS px), bornée à l'intérieur du stage, puis répercute sa position/taille en CSS sur rectEl et ses poignées. */
	private setRect(next: Rect): void {
		const width = clampNum(next.width, MIN_RECT_SIZE, this.stageWidth);
		const height = clampNum(next.height, MIN_RECT_SIZE, this.stageHeight);
		const x = clampNum(next.x, 0, this.stageWidth - width);
		const y = clampNum(next.y, 0, this.stageHeight - height);
		this.rect = { x, y, width, height };

		this.rectEl.style.left = `${x}px`;
		this.rectEl.style.top = `${y}px`;
		this.rectEl.style.width = `${width}px`;
		this.rectEl.style.height = `${height}px`;
	}

	/**
	 * Un seul point d'entrée pour le déplacement ET les quatre poignées de
	 * redimensionnement : `mode` dit lequel des quatre coins bouge (les deux
	 * autres bords restants fixes), ou "move" pour translater le rectangle
	 * entier sans changer sa taille. Écouteurs posés sur `document` (pas sur
	 * rectEl/handle) le temps du geste : sans ça, un glissement rapide qui
	 * dépasse la poignée perdrait le geste en cours de route.
	 */
	private startDrag(evt: PointerEvent, mode: Corner | "move"): void {
		evt.preventDefault();
		evt.stopPropagation();
		const start = { x: evt.clientX, y: evt.clientY };
		const startRect = { ...this.rect };

		const onMove = (moveEvt: PointerEvent) => {
			const dx = moveEvt.clientX - start.x;
			const dy = moveEvt.clientY - start.y;

			if (mode === "move") {
				this.setRect({ ...startRect, x: startRect.x + dx, y: startRect.y + dy });
				return;
			}

			// Chaque coin déplace ses deux bords adjacents, les deux autres
			// restant fixes — d'où les min()/max() : la largeur/hauteur ne
			// doit jamais se calculer à partir d'un bord qui vient de bouger
			// dans le mauvais sens (glisser le coin nw vers la droite, par
			// exemple, ne doit jamais donner une largeur négative).
			let { x, y, width, height } = startRect;
			if (mode === "nw" || mode === "sw") {
				const right = startRect.x + startRect.width;
				x = Math.min(startRect.x + dx, right - MIN_RECT_SIZE);
				width = right - x;
			} else {
				width = Math.max(MIN_RECT_SIZE, startRect.width + dx);
			}
			if (mode === "nw" || mode === "ne") {
				const bottom = startRect.y + startRect.height;
				y = Math.min(startRect.y + dy, bottom - MIN_RECT_SIZE);
				height = bottom - y;
			} else {
				height = Math.max(MIN_RECT_SIZE, startRect.height + dy);
			}
			this.setRect({ x, y, width, height });
		};

		const onUp = () => {
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onUp);
			this.dragCleanup = null;
		};

		this.dragCleanup?.(); // un geste resté accroché (fermeture imprévue) ne doit jamais en bloquer un nouveau
		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", onUp);
		this.dragCleanup = onUp;
	}

	private apply(): void {
		this.onApply({
			x: this.rect.x / this.stageWidth,
			y: this.rect.y / this.stageHeight,
			width: this.rect.width / this.stageWidth,
			height: this.rect.height / this.stageHeight,
		});
		this.close();
	}

	onClose(): void {
		this.dragCleanup?.();
		this.contentEl.empty();
	}
}

function clampNum(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), Math.max(min, max));
}
