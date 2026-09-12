import {
	Menu,
	Notice,
	Scope,
	TFolder,
	TextFileView,
	ViewStateResult,
	WorkspaceLeaf,
	setIcon,
	setTooltip,
} from "obsidian";
import type QuillStonePlugin from "./main";
import {
	BackgroundKind,
	Density,
	DrawElement,
	Drawing,
	DrawingPage,
	ImageElement,
	Orientation,
	PAGE_GAP,
	PAPER_FORMAT_SIZES,
	PaperFormat,
	Pt,
	ShapeElement,
	ShapeKind,
	Stroke,
	StrokeElement,
	createEmptyDrawing,
	createEmptyPage,
	matchPaperFormat,
	newPdfSourceId,
	newStrokeId,
	parse,
	serialize,
	toggleOrientation,
} from "./model";
import {
	ImageResolution,
	RenderColors,
	StrokeBounds,
	boundsNearCircle,
	computeElementBounds,
	distanceToSegment,
	drawElement,
	eraseZone,
	renderScene,
	strokeBounds,
	strokeHitTest,
} from "./render";
import {
	History,
	HistoryEntry,
	applyForward,
	applyInverse,
	applyMovePagesForward,
	applyMovePagesInverse,
	remapPageIndex,
} from "./history";
import {
	ActiveTool,
	BACKGROUND_KINDS,
	BACKGROUND_LABELS,
	ColorableTool,
	DENSITIES,
	DENSITY_LABELS,
	MAX_RECENT_COLORS,
	PAPER_FORMATS,
	PAPER_FORMAT_LABELS,
} from "./settings";
import { simplifyPoints } from "./simplify";
import { resolveColors } from "./colors";
import { openColorPicker } from "./colorPicker";
import { ImageElementCache } from "./imageCache";
import { blobToDataUrl, extensionForMime, readImageDimensions } from "./images";
import { pickFile } from "./filePicker";
import { MovePageModal } from "./movePageModal";
import { GoToPageModal } from "./goToPageModal";
import { CropImageModal } from "./cropModal";
import { ExportPage, buildPdfFromPages } from "./pdfExport";
import {
	Marquee,
	Point,
	STROKE_SELECTION_RATIO,
	boundsIntersect,
	boundsOfPoints,
	imageIntersectsMarquee,
	pointInRect,
	rotatePointAround,
	strokeSelectionRatio,
} from "./selection";

export const VIEW_TYPE_DRAW = "quillstone-view";

/** Après le passage d'un stylet, on ignore les contacts tactiles pendant ce délai (paume posée) — mais seulement un SEUL doigt à la fois, voir onPointerDown. */
const PALM_REJECTION_MS = 2000;

/** Le surligneur est délibérément plus épais que le stylo pour la même épaisseur choisie. */
const HIGHLIGHTER_SIZE_MULTIPLIER = 3;

/** `size` (2/4/8, les trois épaisseurs de la barre d'outils) devient un rayon de gomme utilisable. */
const ERASER_RADIUS_SCALE = 5;

/** Ramer-Douglas-Peucker appliqué au trait terminé (voir finishStroke) : tolérance en pixels logiques de la page. */
const SIMPLIFY_TOLERANCE = 0.5;

/** Marge ajoutée à la boîte englobante d'un trait effacé pour couvrir son épaisseur rendue (la boîte ne suit que les points, pas le lineWidth). */
const ERASE_DIRTY_PADDING = 6;

const SIZES = [2, 4, 8];

/** Durée d'appui maintenu sur une pastille de palette pour ouvrir le sélecteur de remplacement (voir replacePaletteSwatch). Le clic droit ouvre le même sélecteur, instantanément. */
const LONG_PRESS_MS = 500;

/** Largeur d'une colonne de la grille couleurs (voir renderColorPicker) — doit rester égale à la largeur de `.quillstone-swatch` dans styles.css, pastille de base la plus grande des deux tailles, pour que palette et récents s'alignent en colonnes. */
const SWATCH_COL_PX = 18;

/** Pages ajoutées de part et d'autre de la plage réellement visible dont le cache reste entretenu (voir visiblePageRange) — sans ça, un défilement d'un seul pixel au-delà du bord ferait apparaître une page au cache jamais régénéré, visible un instant comme vide. */
const VIRTUALIZE_MARGIN_PAGES = 1;

/** Distance (repère document) entre le bord droit d'une page et son bouton de suppression — voir updateHoverPageButtons : à l'extérieur de la feuille, jamais superposé à son contenu. */
const PAGE_DELETE_BTN_OUTSET = 28;
/** Distance verticale (repère document) entre le bouton de suppression et le bouton « Déplacer », empilé juste au-dessus (voir updateHoverPageButtons) — assez large pour ne jamais se chevaucher, quelle que soit la taille des deux boutons. */
const PAGE_MOVE_BTN_GAP = 34;
/** Marge (repère document), au-delà du bord droit d'une page, qui compte encore comme "survoler cette page" pour la détection de hoveredPageIndex (voir onPointerMove) — doit couvrir PAGE_DELETE_BTN_OUTSET et la taille des boutons, sinon traverser cette marge pour les atteindre fait disparaître hoveredPageIndex avant même d'y arriver. */
const PAGE_HOVER_MARGIN_PX = 50;

/** Facteur d'échelle du bitmap de chaque page à l'export PDF (voir exportToPdf) — au-delà de 1 pour rester net à l'impression : un trait vectoriel n'en a pas besoin, mais un fond scanné (page de PDF importée, voir ImageElement.pdfPage) en profite. */
const PDF_EXPORT_SCALE = 2;

// --- Conversion d'un trait en ligne droite par maintien ---------------------

/** Mouvement (repère du document) au-delà duquel le minuteur de conversion se réarme : sans seuil, la moindre micro-vibration du stylet empêcherait toute conversion. */
const STRAIGHTEN_STILL_THRESHOLD_PX = 3;
const ANGLE_SNAP_STEP_DEG = 15;
/** Distance angulaire en deçà de laquelle l'aimantation s'active spontanément ("quand le curseur en approche"). */
const ANGLE_SNAP_TOLERANCE_DEG = 4;
/** Durée du bref halo qui signale une conversion déclenchée par maintien (jamais par Maj, geste déjà volontaire). */
const STRAIGHTEN_FLASH_MS = 220;
const STRAIGHTEN_HAPTIC_MS = 25;

// --- Menu contextuel (clic droit / appui long tactile) ----------------------

/** Durée d'appui tactile immobile avant l'ouverture du menu contextuel — volontairement plus longue que le délai de conversion en ligne droite (défaut 600 ms) : sur un appui bref, c'est la conversion qui doit gagner, le menu n'arrive que si l'appui se prolonge encore. */
const LONG_PRESS_MENU_MS = 900;
/** Tolérance de mouvement (écran, pas repère logique) avant d'annuler l'appui long : plus large qu'un simple tracé, un doigt immobile n'est jamais parfaitement fixe. */
const LONG_PRESS_MENU_MOVE_THRESHOLD_PX = 10;

// --- Images collées sur la feuille -------------------------------------------

/** Une image insérée occupe au plus cette fraction de la largeur de page, ratio conservé. */
const IMAGE_MAX_WIDTH_RATIO = 0.5;

// --- Pointeur laser ----------------------------------------------------------

/** Durée de vie (ms) d'un point du pointeur laser avant de s'effacer complètement — voir drawLaserTrail. */
const LASER_FADE_MS = 700;
const LASER_COLOR = "#ff3b30";

/**
 * Espacement cible (pixels logiques) entre deux points, pour tout ce qui
 * passe par render.ts:eraseZone — qui ne marque erasé (ou épargné) qu'un
 * SEGMENT ENTIER à la fois, jamais une portion. Sert à échantillonner
 * finement le contour d'un rectangle/ellipse (voir shapeOutlinePoints) et à
 * densifier un trait devenu trop épars (voir densifyForEraser) avant de le
 * lui passer — sans quoi le moindre contact en effacerait bien plus que
 * prévu, jusqu'à l'élément entier dans le pire cas.
 */
const ERASE_SAMPLE_STEP_PX = 12;

// --- Reconnaissance de forme à main levée ------------------------------------
//
// Même déclencheur que la conversion en ligne droite (voir armStillnessTimer) :
// un appui maintenu immobile après un tracé au stylo/surligneur. Mais ici, si
// le tracé forme une boucle refermée qui ressemble à un rond, un rectangle ou
// un triangle, il devient une forme propre (voir ShapeElement) au lieu d'un
// segment droit — voir triggerHoldConversion, seul aiguillage entre les deux.

/** En dessous, le tracé n'a pas de points suffisamment nombreux pour juger sa forme avec confiance. */
const RECOGNIZE_MIN_POINTS = 8;
/** En dessous (pixels logiques), une boîte englobante trop petite pour distinguer fiablement rond/rectangle/triangle d'un simple gribouillis. */
const RECOGNIZE_MIN_SIZE_PX = 20;
/** Écart toléré entre le premier et le dernier point du tracé, en proportion de la diagonale de sa boîte englobante — en deçà, la boucle est considérée refermée sur elle-même. */
const CLOSED_PATH_GAP_RATIO = 0.22;
/** Coefficient de variation (écart-type / moyenne) des distances au centre : en dessous, le tracé est jugé assez rond pour devenir une ellipse. */
const CIRCLE_ROUNDNESS_THRESHOLD = 0.2;
/** Tolérance de simplification agressive (proportion de la plus grande dimension de la boîte englobante) pour ne garder que les sommets dominants d'une boucle NON ronde — 3 sommets restants = triangle, 4 = rectangle, tout le reste = pas reconnu. */
const CORNER_SIMPLIFY_RATIO = 0.09;

// "hand" juste avant curseur/lasso : les trois outils qui ne dessinent
// jamais, groupés ensemble, main en premier puisque c'est le seul des trois
// qui ne touche jamais au document (voir ActiveTool, settings.ts). Curseur
// avant lasso : le plus direct au quotidien (clic-glisser immédiat sur un
// élément, sans étape d'entourage). "capture" en dernier : il trace un
// rectangle comme le lasso, mais pour en faire une image plutôt qu'une
// sélection (voir finishCapture) — proche du lasso dans le geste, distinct
// dans l'intention.
const TOOLS: ActiveTool[] = [
	"pen",
	"highlighter",
	"eraser-zone",
	"eraser-stroke",
	"hand",
	"cursor",
	"select",
	"capture",
];

/** Palette de formes prédéfinies, dans son propre groupe de la barre d'outils (voir buildToolbar) — pas mêlée à TOOLS. Le carré et le rond n'ont pas leur propre outil : Maj maintenue pendant le tracé donne un rapport 1:1 à "rectangle"/"ellipse", exactement comme le redimensionnement d'une sélection ailleurs dans le plugin. */
const SHAPE_TOOLS: ShapeKind[] = ["rectangle", "ellipse", "triangle", "line", "arrow"];

const TOOL_ICONS: Record<ActiveTool, string> = {
	pen: "pencil",
	highlighter: "highlighter",
	"eraser-zone": "eraser",
	"eraser-stroke": "trash-2",
	cursor: "mouse-pointer-2",
	select: "lasso",
	capture: "camera",
	rectangle: "square",
	ellipse: "circle",
	triangle: "triangle",
	line: "slash",
	arrow: "arrow-up-right",
	laser: "flashlight",
	hand: "hand",
};

const TOOL_LABELS: Record<ActiveTool, string> = {
	pen: "Pen",
	highlighter: "Highlighter",
	"eraser-zone": "Eraser (zone)",
	"eraser-stroke": "Eraser (whole stroke)",
	rectangle: "Rectangle",
	ellipse: "Ellipse",
	triangle: "Triangle",
	line: "Line",
	arrow: "Arrow",
	laser: "Laser pointer",
	cursor: "Cursor",
	select: "Lasso",
	capture: "Capture an area",
	hand: "Hand (pan)",
};

// --- Outil sélection ---------------------------------------------------------

/** Tolérance de clic (repère de la page) pour toucher un trait fin avec l'outil sélection — comme la gomme, un clic pixel-parfait sur une ligne de 1px serait inutilisable. */
const SELECT_HIT_TOLERANCE_PX = 6;
/** Taille (écran) des poignées de redimensionnement carrées. */
const HANDLE_SIZE_PX = 9;
/** Distance (écran) entre le haut du cadre et la poignée de rotation. */
const ROTATE_HANDLE_OFFSET_PX = 26;
/** Rayon de préhension (écran) autour d'une poignée : plus grand que sa taille visuelle, pour rester atteignable au doigt. */
const HANDLE_GRAB_RADIUS_PX = 14;
/** Rayon (écran) du badge cadenas dessiné au coin d'un élément verrouillé. */
const LOCK_BADGE_RADIUS_PX = 7;
const SELECTION_ROTATE_SNAP_DEG = 15;
const SELECTION_NUDGE_PX = 1;
const SELECTION_NUDGE_FAST_PX = 10;
/** Décalage (repère de la page) appliqué à un collage, pour qu'il ne tombe jamais exactement sur l'original. */
const PASTE_OFFSET_PX = 16;
const MARQUEE_DASH_SPEED_PX_PER_S = 24;
/** En dessous de cette taille (repère de la page), un rectangle de capture est traité comme un clic sans intention, pas une zone à capturer (voir finishCapture) — même idée que le seuil équivalent pour une forme, finishShape. */
const MIN_CAPTURE_SIZE_PX = 4;
/** Résolution du bitmap capturé, en multiple de sa taille logique — plus net qu'un rendu 1:1 quand on zoome ensuite sur l'image posée (voir finishCapture). */
const CAPTURE_SCALE = 2;

type ResizeHandle = "nw" | "n" | "ne" | "w" | "e" | "sw" | "s" | "se";
const RESIZE_HANDLES: ResizeHandle[] = ["nw", "n", "ne", "w", "e", "sw", "s", "se"];
/** Pour chaque poignée, quels axes elle fait varier (-1 = bord gauche/haut mobile, 1 = bord droit/bas mobile, 0 = axe verrouillé). */
const HANDLE_AXES: Record<ResizeHandle, { x: -1 | 0 | 1; y: -1 | 0 | 1 }> = {
	nw: { x: -1, y: -1 },
	n: { x: 0, y: -1 },
	ne: { x: 1, y: -1 },
	w: { x: -1, y: 0 },
	e: { x: 1, y: 0 },
	sw: { x: -1, y: 1 },
	s: { x: 0, y: 1 },
	se: { x: 1, y: 1 },
};

type SelectionHandle = ResizeHandle | "rotate";

/**
 * Vrai pour le curseur ou le lasso : les deux outils qui partagent toute la
 * machinerie de sélection (poignées, transformation, verrouillage,
 * raccourcis) — voir onSelectPointerDown. Seule différence entre eux : le
 * lasso peut entourer une zone vide (allowMarquee), le curseur jamais.
 */
function isSelectionTool(tool: ActiveTool): tool is "select" | "cursor" {
	return tool === "select" || tool === "cursor";
}

function isShapeTool(tool: ActiveTool): tool is ShapeKind {
	return tool === "rectangle" || tool === "ellipse" || tool === "triangle" || tool === "line" || tool === "arrow";
}

/**
 * Le presse-papier natif Electron (voir copySelectionToClipboard/
 * pasteFromClipboard) n'existe QUE sur desktop — Obsidian mobile n'embarque
 * pas Electron, `require("electron")` y lève. Jamais un `import` statique
 * (comme avant) : ça ferait échouer le CHARGEMENT DU PLUGIN ENTIER sur
 * mobile, bien avant qu'aucune fonctionnalité presse-papier ne soit
 * sollicitée. Chargé à la demande ici, mis en cache après le premier essai
 * (succès ou échec, `undefined` distinguant « pas encore essayé » de
 * « essayé, absent ») pour ne tenter qu'une fois par session — jamais de
 * nouvel essai coûteux à chaque Ctrl+C/Ctrl+V.
 */
let electronModule: typeof import("electron") | null | undefined;
function getElectron(): typeof import("electron") | null {
	if (electronModule === undefined) {
		try {
			electronModule = window.require?.("electron") ?? null;
		} catch {
			electronModule = null;
		}
	}
	return electronModule ?? null;
}

/** Marqueur d'un fragment de presse-papier interne au plugin, écrit en `text/plain` à côté du PNG (voir copySelectionToClipboard) : distingue un collage entre feuilles d'une simple image externe. */
const CLIPBOARD_MARKER = "quillstone-clipboard-v1";

interface ClipboardPayload {
	marker: typeof CLIPBOARD_MARKER;
	elements: DrawElement[];
}

// --- Zoom / panoramique ------------------------------------------------------

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
/** Plafond de l'échelle calculée par fitToWindow()/fitWidthToWindow() — distinct de MAX_SCALE (celui-ci ne borne que le zoom manuel, molette/pincement/+). Une fenêtre large ne doit pas agrandir une page au-delà de sa taille réelle (100 %) juste pour en remplir la largeur : au-delà, elle reste centrée à 100 % plutôt que de s'étirer. */
const FIT_MAX_SCALE = 1;
const ZOOM_STEP = 1.25;
/** Exposant appliqué par pixel de molette : deltaY négatif (molette vers le haut) zoome avant. */
const WHEEL_ZOOM_SPEED = 0.0018;
/** Délai après lequel un geste de zoom est considéré terminé, pour régénérer le cache à la bonne échelle. */
const ZOOM_SETTLE_MS = 200;
/**
 * Borne la résolution du cache hors écran : au-delà, le zoom reste flou
 * (recopie agrandie) plutôt que de faire exploser la mémoire — à l'échelle
 * maximale (8x) avec un écran haute densité, une résolution non bornée
 * dépasserait le gigaoctet pour une seule page.
 */
const MAX_CACHE_SCALE = 4;
/** Écart relatif d'échelle en dessous duquel on ne régénère pas le cache (un panoramique pur ne doit rien régénérer). */
const CACHE_RESCALE_THRESHOLD = 0.05;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** État d'affichage (pas une propriété du document) : échelle et décalage du DOCUMENT entier (toutes les pages empilées) à l'écran — voir layoutPages. */
interface Viewport {
	scale: number;
	offsetX: number;
	offsetY: number;
}

type ViewportGesture =
	| {
			type: "pan";
			pointerId: number;
			startClientX: number;
			startClientY: number;
			startOffsetX: number;
			startOffsetY: number;
	  }
	| {
			type: "pinch";
			pointerIds: [number, number];
			startDistance: number;
			startScale: number;
			startMidDocument: [number, number];
	  };

/**
 * État d'un trait en cours de « redressement » (voir DrawView.triggerStraighten) :
 * le trait n'est plus une capture au fil du pointeur mais un segment
 * origine→extrémité maintenu à jour dans activeStroke.points (toujours
 * exactement 2 points, voir updateStraightLine). `pressureSum`/`pressureCount`
 * accumulent TOUTES les pressions vues depuis le début du geste (avant ET
 * après la conversion), pour que l'épaisseur finale soit bien la moyenne du
 * trait d'origine, pas seulement des deux extrémités actuelles.
 */
interface StraightLineState {
	originXY: [number, number];
	pressureSum: number;
	pressureCount: number;
	/** Angle affiché (aimanté ou non) ; `null` tant que l'extrémité n'a pas encore bougé de l'origine (segment de longueur nulle, aucune direction). */
	snapAngleDeg: number | null;
}

/** Un geste (trait, gomme, lasso, transformation) commence toujours sur UNE page — voir hitPage — et y reste confiné jusqu'à sa fin, même si le pointeur dérive ensuite au-dessus d'une page voisine : chaque session ci-dessous fige donc son `pageIndex` dès sa création. */
interface EraseZoneSession {
	pageIndex: number;
	/** État de chaque trait OU forme (jamais une image, la gomme ne la touche jamais) avant le geste : id -> {index dans page.elements, élément}. Sert à réinsérer exactement au bon endroit lors d'un undo. */
	originalSnapshot: Map<string, { index: number; element: DrawElement }>;
	/** Ids d'origine touchés pendant ce geste (donc à faire disparaître au profit de leurs fragments). */
	touchedOriginalIds: Set<string>;
	/** Ids des fragments créés pendant ce geste et encore vivants (non re-découpés depuis) — traits pour un trait ou une forme rectangle/ellipse touchée (voir eraseShapeOutlineZone), ligne/flèche raccourcie pour une forme ligne/flèche (voir eraseLineZone). */
	liveFragmentIds: Set<string>;
}

interface EraseStrokeSession {
	pageIndex: number;
	/** Index dans page.elements au début du geste, trait ou image confondus. */
	originalIndex: Map<string, number>;
	removed: { index: number; element: DrawElement }[];
}

/**
 * Déplacement, redimensionnement ou rotation en cours sur la sélection.
 * `snapshot` fige l'état d'origine (clones profonds) au pointerdown : chaque
 * frame recalcule `currentTransformed` à partir de CE snapshot, jamais de
 * façon incrémentale — sans ça, l'arrondi flottant dériverait au fil des
 * événements pointeur. `page.elements` n'est jamais touché avant
 * commitTransform() : voir redrawSelectionOverlay, qui affiche
 * currentTransformed par-dessus un arrière-plan mis en cache une seule fois
 * au début du geste (transformBgCanvas), pas régénéré à chaque frame.
 */
interface TransformSession {
	pageIndex: number;
	kind: "move" | "resize" | "rotate";
	handle?: ResizeHandle;
	originalBounds: StrokeBounds;
	snapshot: DrawElement[];
	startLogical: [number, number];
	currentTransformed: DrawElement[];
}

/**
 * État de vue et de rendu d'UNE page (voir DrawingPage, model.ts, pour son
 * contenu) : son propre cache hors écran (bitmap des traits validés, voir
 * strokesCacheCanvas dans l'ancienne version à page unique du plugin),
 * entretenu et invalidé indépendamment de celui des autres pages, et sa
 * position dans le repère document partagé (originX/originY, voir
 * DrawView.layoutPages) — jamais écrite dans le .draw, recalculée à chaque
 * changement de structure du document.
 */
interface PageRuntime {
	page: DrawingPage;
	cacheCanvas: HTMLCanvasElement;
	cacheCtx: CanvasRenderingContext2D;
	cacheScale: number;
	/** Vrai dès que le cache ne reflète plus le modèle (chargement, ajout/suppression de page, geste terminé sur cette page, réglage de rendu changé) : régénéré au prochain passage de cette page dans la plage visible (voir redrawViewport), jamais avant — c'est ce qui rend la virtualisation possible. */
	cacheDirty: boolean;
	/** Zone touchée par la gomme depuis le dernier redessin régional de CETTE page (repère de la page), accumulée entre événements pointeur — voir markErasedRegion. */
	dirtyBounds: StrokeBounds | null;
	committedRedrawHandle: number | null;
	/** Coin haut-gauche de cette page dans le repère document (voir layoutPages) — jamais une propriété du document lui-même, recalculée à chaque changement de structure. */
	originX: number;
	originY: number;
}

/**
 * TextFileView gère pour nous le cycle de vie du fichier : Obsidian appelle
 * setViewData() à l'ouverture et getViewData() quand il faut écrire sur le disque.
 * Notre travail se résume à convertir entre le texte JSON et l'objet Drawing,
 * et à appeler requestSave() dès que le dessin change.
 */
export class DrawView extends TextFileView {
	/** Le document entier (toutes les pages) — voir aussi `pages`, l'état de rendu correspondant, jamais sérialisé lui-même. */
	doc: Drawing = createEmptyDrawing();
	/** Un PageRuntime par page de `doc.pages`, dans le même ordre — reconstruit entièrement à chaque chargement (voir rebuildPageRuntimes), tenu à jour incrémentalement par insertPageAt/deletePage ensuite. */
	private pages: PageRuntime[] = [];
	/** Largeur totale du document en repère document (la plus large des pages) — voir layoutPages. */
	private documentWidth = 1;

	private toolbarEl!: HTMLDivElement;
	private colorsGroupEl!: HTMLDivElement;
	private zoomLabelEl!: HTMLDivElement;
	/** « Page X / N », cliquable pour choisir directement une page (voir promptGoToPage) — tenu à jour à chaque redessin du volet, voir redrawViewport. */
	private pageIndicatorEl!: HTMLDivElement;
	private wrapper!: HTMLDivElement;

	/**
	 * Deux canvas empilés, tous deux à la taille du volet visible (pas d'une
	 * page — voir Viewport) :
	 *  - committedCanvas : la fenêtre visible sur le document, recopiée avec
	 *    la transformation vue courante à chaque changement de cadrage —
	 *    une page à la fois, depuis son propre cache (voir redrawViewport).
	 *  - activeCanvas : transparent, par-dessus, pour le trait en cours, le
	 *    cercle de la gomme, la sélection ou le lasso.
	 */
	private committedCanvas!: HTMLCanvasElement;
	private committedCtx!: CanvasRenderingContext2D;
	private activeCanvas!: HTMLCanvasElement;
	private activeCtx!: CanvasRenderingContext2D;

	/** Un bouton « + » par page, toujours affiché dans l'interstice SOUS elle (voir syncAddPageButtons) — jamais un bouton unique repositionné au survol comme pageDeleteBtn : l'utilisateur doit pouvoir insérer une page entre deux existantes sans avoir à en survoler une d'abord. */
	private addPageBtns: HTMLDivElement[] = [];
	private pageDeleteBtn!: HTMLDivElement;
	/** Bouton « Déplacer cette page » (voir promptMovePage) — même mécanisme que pageDeleteBtn : un seul élément repositionné sur la page survolée, juste au-dessus du bouton de suppression (voir updateHoverPageButtons). */
	private pageMoveBtn!: HTMLDivElement;
	/** Page sous le pointeur (souris/stylet, jamais le tactile — voir onPointerMove), pour positionner pageDeleteBtn ; `null` si le pointeur est hors de toute page ou qu'un geste est en cours. */
	private hoveredPageIndex: number | null = null;
	/**
	 * Page en cours de glisser-déposer (voir pageMoveBtn:dragstart), `null`
	 * hors glissement — un glisser-déposer HTML5 natif entre pageMoveBtn
	 * (poignée) et les boutons « + » de chaque interstice (cibles de dépôt,
	 * voir createAddPageButton), entièrement séparé du pointeur du canvas
	 * (tracé, sélection…) : aucune interférence avec ces gestes-là.
	 */
	private dragSourcePageIndex: number | null = null;

	private viewport: Viewport = { scale: 1, offsetX: 0, offsetY: 0 };
	/** Vrai si setState() a restauré un cadrage enregistré : évite d'écraser cette restauration par un fitToWindow() par défaut dans onOpen(). */
	private viewportRestored = false;
	private viewportGesture: ViewportGesture | null = null;
	private viewportRedrawScheduled = false;
	private spacePressed = false;
	/** Tous les pointeurs actuellement enfoncés, tactiles compris — nécessaire pour distinguer un doigt unique (rejeté après usage du stylet) d'un geste à deux doigts (accepté). */
	private pointers = new Map<number, PointerEvent>();

	private resizeObserver?: ResizeObserver;
	/** Débounce d'une régénération complète de toutes les pages après un geste de zoom (voir scheduleCacheRegenAfterSettle) — un seul minuteur pour tout le document, pas par page. */
	private cacheRegenTimeout: number | null = null;

	private history = new History();

	private toolButtons = new Map<ActiveTool, HTMLElement>();
	/** Outil dont la palette est actuellement affichée dans colorsGroupEl — null force une reconstruction au prochain syncToolbarState() (voir refreshToolbar). Sert à ne reconstruire la palette (renderColorPicker) que quand l'outil actif change réellement, pas à chaque synchronisation. */
	private colorsGroupTool: ColorableTool | null = null;
	/** Pastilles de la palette et des récents actuellement affichées, pour ne mettre à jour que leur classe .is-active (syncColorActiveStates) sans reconstruire le DOM à chaque changement de couleur. */
	private paletteSwatchEls: HTMLElement[] = [];
	private recentSwatchEls: HTMLElement[] = [];
	/** Le bouton lui-même EST la pastille de la couleur active (fond = entry.active) : son fond doit donc suivre l'aperçu en direct pendant un glissement dans le sélecteur, voir previewColorLive. */
	private freePickerButtonEl: HTMLElement | null = null;
	private sizeButtons = new Map<number, HTMLElement>();
	/** Bouton unique ouvrant le menu des formes prédéfinies (voir openShapeMenu) — pas dans toolButtons comme les autres outils : son icône et son état actif suivent la forme active, tenus à jour à part dans syncToolbarState. */
	private shapesMenuBtn!: HTMLElement;
	private undoBtn!: HTMLElement;
	private redoBtn!: HTMLElement;
	/** Groupe premier/arrière-plan, verrou et suppression : n'a de sens qu'avec une sélection non vide (voir updateSelectionActionsToolbar). */
	private selectionActionsGroupEl!: HTMLDivElement;
	private lockBtn!: HTMLElement;
	private cropBtn!: HTMLElement;

	// --- État du geste en cours (trait, gomme par zone ou gomme par trait) ---
	private activePointerId: number | null = null;
	private activeStroke: StrokeElement | null = null;
	/** Page sur laquelle porte activeStroke — voir la note en tête d'EraseZoneSession : fixée au pointerdown, jamais recalculée en cours de geste. */
	private activeStrokePageIndex: number | null = null;
	/** Forme en cours de tracé avec la palette de formes (voir isShapeTool) — même principe qu'activeStroke, mais recalculée entièrement à chaque mouvement (updateActiveShape) plutôt qu'accumulée point par point. */
	private activeShape: ShapeElement | null = null;
	private activeShapePageIndex: number | null = null;
	/** Point de départ du glissement (repère de activeShapePageIndex), fixe pour toute la durée du geste — sert d'ancre à updateActiveShape pour recalculer x/y/width/height à chaque mouvement, jamais accumulé de façon incrémentale (même raison que TransformSession.snapshot : éviter toute dérive d'arrondi). */
	private activeShapeStart: [number, number] | null = null;
	/**
	 * Vrai juste après qu'une forme fraîchement créée (palette de formes, ou
	 * reconnue automatiquement à main levée — voir finishShape/finishStroke)
	 * a fait basculer automatiquement l'outil sur le lasso pour la
	 * déplacer/redimensionner tout de suite : dès qu'un clic tombe à côté
	 * (désélection, voir onSelectPointerDown), l'outil revient de lui-même
	 * au stylo plutôt que de laisser le lasso actif sans qu'on l'ait choisi
	 * soi-même. Reste armé tant qu'on continue d'interagir avec CETTE forme
	 * précise (la redimensionner via ses poignées, la redéplacer, recliquer
	 * dessus — voir autoSelectShapeId) : sélectionner autre chose annule ce
	 * comportement ponctuel sans le déclencher, on considère alors l'outil
	 * sélection utilisé intentionnellement pour autre chose. Remis à faux
	 * par tout changement d'outil (voir setTool), qu'il vienne d'ici ou d'un
	 * clic normal sur la barre d'outils.
	 */
	private returnToPenAfterDeselect = false;
	/** Id de la forme qui a armé returnToPenAfterDeselect — voir sa doc : distingue "on interagit encore avec elle" (grâce conservée) de "on a sélectionné autre chose" (grâce annulée), voir onSelectPointerDown. */
	private autoSelectShapeId: string | null = null;
	/** Non nul dès que le trait en cours (stylo/surligneur) est devenu un segment droit — par maintien immobile ou par Maj dès le pointerdown. */
	private straightLine: StraightLineState | null = null;
	/**
	 * Non nul dès qu'un tracé en cours a été reconnu comme un rond, un
	 * rectangle ou un triangle (voir recognizeClosedShape,
	 * triggerHoldConversion) — alternative à straightLine pour le même
	 * déclencheur (maintien immobile), jamais les deux à la fois. `size`
	 * capture la taille au moment de la reconnaissance : continuer à glisser
	 * ensuite agrandit/réduit la forme depuis son centre (voir
	 * updateRecognizedShapeScale), pas une poignée précise — le tracé
	 * d'origine n'a pas de coin ou de rayon "à saisir" comme le ferait un
	 * geste de redimensionnement classique.
	 */
	private recognizedShape: ShapeElement | null = null;
	private recognizedShapeAnchor: { cx: number; cy: number; baseWidth: number; baseHeight: number } | null = null;
	/** Minuteur de conversion par maintien (voir armStillnessTimer) ; jamais actif après conversion, ni pour la gomme. */
	private strokeHoldTimer: number | null = null;
	/** Position à laquelle le minuteur a été (ré)armé — tout mouvement au-delà de STRAIGHTEN_STILL_THRESHOLD_PX le réarme ailleurs. */
	private strokeHoldAnchor: [number, number] | null = null;
	/** Horodatage (performance.now()) du déclenchement du halo de conversion ; `null` = pas d'animation en cours. */
	private straightenFlashStart: number | null = null;
	private straightenFlashHandle: number | null = null;
	private eraseZoneSession: EraseZoneSession | null = null;
	private eraseStrokeSession: EraseStrokeSession | null = null;
	private eraserPreviewPoint: [number, number] | null = null;
	/** Page sur laquelle porte eraserPreviewPoint — `null` si le survol ne tombe sur aucune page. */
	private eraserPreviewPageIndex: number | null = null;
	/**
	 * Points du pointeur laser (repère DOCUMENT, jamais celui d'une page — cet
	 * outil pointe sur l'écran, pas sur le contenu, et n'a donc pas besoin de
	 * page pour fonctionner) avec l'horodatage de leur capture. Purement
	 * visuel : jamais lu par getViewData()/serialize(), jamais dans
	 * l'historique — le seul outil du plugin qui ne modifie jamais le
	 * document. Les points les plus anciens s'effacent tout seuls, voir
	 * scheduleLaserAnimation/drawLaserTrail.
	 */
	private laserPoints: { x: number; y: number; t: number }[] = [];
	private laserAnimHandle: number | null = null;
	private activeRedrawScheduled = false;
	private lastPenActiveAt = -Infinity;
	private ignoredPointerIds = new Set<number>();

	/** Appui tactile immobile en cours, en vue d'ouvrir le menu contextuel (voir armLongPressMenu) — coordonnées écran, pas repère document : ce minuteur ne dessine rien, il ne fait que positionner un menu. */
	private longPressMenuTimer: number | null = null;
	private longPressMenuStart: { clientX: number; clientY: number } | null = null;

	/** Bitmaps des images de la feuille, chargés une seule fois et jamais relus à chaque frame — voir imageCache.ts. Partagé par toutes les pages du document : une même image collée sur deux pages n'est chargée qu'une fois. */
	private imageCache!: ImageElementCache;

	// --- Outil sélection ----------------------------------------------------------
	private selectedIds = new Set<string>();
	/** Page à laquelle appartient la sélection courante — `null` si `selectedIds` est vide. Invariant : `selectedIds.size > 0` implique `selectedPageIndex !== null` (voir setSelection/clearSelection). Une sélection ne franchit jamais la frontière entre deux pages. */
	private selectedPageIndex: number | null = null;
	/** Page la plus récemment ciblée par un geste (tracé, gomme, sélection) — sert de page par défaut pour les actions qui n'ont pas de position propre (bouton « Fond, densité, format, orientation » de la barre d'outils, par exemple). */
	private focusedPageIndex = 0;
	/** Lasso/rectangle en cours de tracé — points bruts (repère de la page pageIndex) ; voir currentMarqueeShape() pour la forme réellement testée. */
	private activeMarquee: { pageIndex: number; mode: "rect" | "lasso"; points: Point[] } | null = null;
	private marqueeDashOffset = 0;
	private marqueeAnimHandle: number | null = null;
	private transformSession: TransformSession | null = null;
	/** Rendu une seule fois au début d'une transformation (voir TransformSession) : le cache des éléments validés SANS les éléments sélectionnés, à recopier tel quel à chaque frame plutôt que régénéré. */
	private transformBgCanvas: HTMLCanvasElement | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: QuillStonePlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_DRAW;
	}

	getDisplayText(): string {
		return this.file?.basename ?? "Sheet";
	}

	getIcon(): string {
		return "pencil";
	}

	// --- Pont avec le fichier -------------------------------------------------

	getViewData(): string {
		return serialize(this.doc);
	}

	setViewData(data: string, _clear: boolean): void {
		this.doc = parse(data);
		this.rebuildPageRuntimes();
		this.history = new History();
		this.selectedIds.clear();
		this.selectedPageIndex = null;
		this.focusedPageIndex = 0;
		this.hoveredPageIndex = null;
		this.updateHistoryButtons();
		this.resizeCanvas();
		// Le cadrage est une propriété d'affichage, pas du document : une
		// feuille chargée pour la première fois (pas de setState() derrière)
		// doit s'afficher entièrement plutôt qu'au cadrage de la précédente,
		// potentiellement d'un format différent.
		this.fitToWindow();
		this.render();
	}

	clear(): void {
		this.doc = createEmptyDrawing();
		this.rebuildPageRuntimes();
		this.history = new History();
		this.selectedIds.clear();
		this.selectedPageIndex = null;
		this.focusedPageIndex = 0;
		this.hoveredPageIndex = null;
		this.updateHistoryButtons();
		this.fitToWindow();
		this.render();
	}

	/**
	 * Le cadrage (échelle + décalage) est un état d'affichage, pas une
	 * propriété du .draw (voir Viewport) : il n'est jamais sérialisé par
	 * getViewData(). On le conserve à la place dans l'état de la vue
	 * Obsidian, pour qu'il survive à un changement d'onglet.
	 */
	getState(): Record<string, unknown> {
		return {
			...super.getState(),
			viewport: { ...this.viewport },
		};
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		const saved = (state as { viewport?: Partial<Viewport> } | null | undefined)?.viewport;
		if (
			saved &&
			typeof saved.scale === "number" &&
			typeof saved.offsetX === "number" &&
			typeof saved.offsetY === "number"
		) {
			this.viewport = { scale: saved.scale, offsetX: saved.offsetX, offsetY: saved.offsetY };
			this.viewportRestored = true;
			this.onViewportChanged();
		}
	}

	// --- Pages du document ---------------------------------------------------------

	private createPageRuntime(page: DrawingPage): PageRuntime {
		const cacheCanvas = document.createElement("canvas");
		const cacheCtx = cacheCanvas.getContext("2d");
		if (!cacheCtx) throw new Error("Canvas 2D indisponible");
		return {
			page,
			cacheCanvas,
			cacheCtx,
			cacheScale: 1,
			cacheDirty: true,
			dirtyBounds: null,
			committedRedrawHandle: null,
			originX: 0,
			originY: 0,
		};
	}

	/** Reconstruit tout l'état de rendu depuis `doc.pages` — à chaque chargement (voir setViewData/clear), jamais lors d'un simple ajout/suppression de page (voir insertPageAt/deletePage, qui maintiennent `pages` incrémentalement). */
	private rebuildPageRuntimes(): void {
		for (const rt of this.pages) {
			if (rt.committedRedrawHandle !== null) window.cancelAnimationFrame(rt.committedRedrawHandle);
		}
		this.pages = this.doc.pages.map((page) => this.createPageRuntime(page));
		this.layoutPages();
	}

	/**
	 * Place chaque page dans le repère document partagé : empilées
	 * verticalement, séparées par PAGE_GAP, chacune centrée horizontalement
	 * sur la largeur de la plus large d'entre elles (une page paysage au
	 * milieu de pages portrait ne décale pas les suivantes). Recalculé après
	 * tout changement de structure (chargement, ajout/suppression de page,
	 * changement d'orientation) — bon marché, une seule passe arithmétique
	 * sur `pages`, jamais un redessin.
	 */
	private layoutPages(): void {
		let maxWidth = 1;
		for (const rt of this.pages) maxWidth = Math.max(maxWidth, rt.page.width);

		let y = 0;
		for (const rt of this.pages) {
			rt.originX = (maxWidth - rt.page.width) / 2;
			rt.originY = y;
			y += rt.page.height + PAGE_GAP;
		}
		this.documentWidth = maxWidth;

		// wrapper n'existe pas encore lors du tout premier rebuildPageRuntimes()
		// d'onOpen() (appelé avant la construction du DOM, voir onOpen) : rien à
		// synchroniser à ce moment-là, onOpen le fait lui-même juste après avoir
		// créé le conteneur.
		if (this.wrapper) this.syncAddPageButtons();
	}

	/**
	 * Crée le bouton « + » d'un interstice — voir syncAddPageButtons, seul
	 * appelant. Son index (donc la page après laquelle il insère/dépose)
	 * n'est jamais figé dans une fermeture : il est relu depuis sa position
	 * courante dans addPageBtns à chaque clic ou dépôt, ce qui reste correct
	 * même après des insertions/suppressions ailleurs dans le document.
	 *
	 * Double comme cible de dépôt du glisser-déposer de page (voir
	 * pageMoveBtn:dragstart, dragSourcePageIndex) : déposer sur l'interstice
	 * après la page `gapIndex` place la page glissée entre `gapIndex` et
	 * `gapIndex + 1` DANS LE RÉSULTAT FINAL, quel que soit le sens du
	 * glissement — d'où le +1 seulement quand la source était déjà après ce
	 * point (voir le calcul de `to`, même principe que remapPageIndex,
	 * history.ts, mais pour un index de dépôt plutôt qu'un index existant).
	 */
	private createAddPageButton(): HTMLDivElement {
		const btn = this.wrapper.createDiv({ cls: "quillstone-add-page-btn" });
		setIcon(btn, "plus");
		btn.setAttribute("role", "button");
		btn.setAttribute("aria-label", "Add a page here");
		setTooltip(btn, "Add a page here");
		btn.addEventListener("click", () => {
			const index = this.addPageBtns.indexOf(btn);
			if (index !== -1) this.insertPageAt(index + 1);
		});

		btn.addEventListener("dragover", (evt) => {
			if (this.dragSourcePageIndex === null) return;
			evt.preventDefault(); // sans ça, "drop" ne se déclenche jamais (comportement par défaut du navigateur : refuser le dépôt)
			if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
			btn.addClass("is-drop-target");
		});
		btn.addEventListener("dragleave", () => btn.removeClass("is-drop-target"));
		btn.addEventListener("drop", (evt) => {
			evt.preventDefault();
			btn.removeClass("is-drop-target");
			const from = this.dragSourcePageIndex;
			const gapIndex = this.addPageBtns.indexOf(btn);
			this.dragSourcePageIndex = null;
			if (from === null || gapIndex === -1) return;
			this.movePageTo(from, from <= gapIndex ? gapIndex : gapIndex + 1);
		});

		return btn;
	}

	/**
	 * Maintient un bouton « + » par page (voir addPageBtns) : un par
	 * interstice, y compris celui sous la toute dernière page. Appelé après
	 * tout changement du nombre de pages (voir layoutPages, son seul
	 * appelant) — ne fait que créer/retirer des éléments, jamais les
	 * repositionner (voir updateAddPageButtonsPositions, appelé séparément à
	 * chaque redessin du volet).
	 */
	private syncAddPageButtons(): void {
		while (this.addPageBtns.length < this.pages.length) {
			this.addPageBtns.push(this.createAddPageButton());
		}
		while (this.addPageBtns.length > this.pages.length) {
			this.addPageBtns.pop()?.remove();
		}
	}

	/**
	 * Insère une nouvelle page à `index`, avec le fond et l'orientation par
	 * défaut des réglages du plugin (voir
	 * QuillStoneSettings.newPageBackground/newPageOrientation — distincts du
	 * fond par défaut d'une feuille nouvellement créée). `index === this.pages.length`
	 * l'ajoute en fin de document (cas du bouton du tout dernier interstice) ;
	 * n'importe quel autre index l'insère entre deux pages existantes (voir
	 * syncAddPageButtons, un bouton par interstice).
	 */
	private insertPageAt(index: number): void {
		const page = createEmptyPage(
			this.plugin.settings.newPageBackground,
			this.plugin.settings.defaultDensity,
			this.plugin.settings.newPageOrientation
		);
		this.insertPagesAt(index, [page]);
	}

	/**
	 * Pendant de insertPageAt() pour plusieurs pages d'un coup (voir
	 * importPdfIntoDocument : toutes les pages d'un PDF importé arrivent
	 * ensemble) — un seul recalcul de mise en page/sauvegarde/redessin pour
	 * tout le lot, plutôt que N appels séquentiels à insertPageAt(). Décale
	 * l'historique d'autant de crans qu'il y a de pages insérées (un appel à
	 * History.insertPage(index) par page, voir sa doc), fait défiler jusqu'à
	 * la première page insérée.
	 */
	private insertPagesAt(index: number, pages: DrawingPage[]): void {
		if (pages.length === 0) return;

		this.doc.pages.splice(index, 0, ...pages);
		this.pages.splice(index, 0, ...pages.map((page) => this.createPageRuntime(page)));
		for (let i = 0; i < pages.length; i++) this.history.insertPage(index);

		if (this.selectedPageIndex !== null && this.selectedPageIndex >= index) this.selectedPageIndex += pages.length;
		if (this.focusedPageIndex >= index) this.focusedPageIndex += pages.length;
		// Les interstices se décalent : un survol en cours ne désigne plus
		// forcément la même page, laissé à null pour être recalculé au
		// prochain mouvement du pointeur plutôt que de risquer un index faux.
		this.hoveredPageIndex = null;

		this.layoutPages();
		this.updateHistoryButtons();
		this.requestSave();
		this.redrawViewport();
		this.scrollToPage(index);
	}

	/**
	 * Bouton « Importer un PDF » de la barre d'outils (voir buildToolbar) :
	 * ajoute les pages d'un PDF choisi par l'utilisateur À LA SUITE de ce
	 * document déjà ouvert, plutôt que d'en créer un nouveau — voir
	 * main.ts:importPdfAsDrawing pour le chemin « nouvelle feuille » (palette
	 * de commandes / clic droit dans une note), qui reste distinct et
	 * indépendant de celui-ci. Les deux délèguent la même construction de
	 * pages à main.ts:QuillStonePlugin.buildPdfPages, jamais dupliquée ici.
	 */
	private async importPdfIntoDocument(): Promise<void> {
		const pdfFile = await pickFile("application/pdf");
		if (!pdfFile) return;

		const notice = new Notice("Importing PDF…", 0);
		try {
			const newPages = await this.plugin.buildPdfPages(pdfFile, notice);

			this.insertPagesAt(this.pages.length, newPages);
			notice.hide();
			new Notice(
				`PDF imported: ${newPages.length} page${newPages.length > 1 ? "s" : ""} added.`
			);
		} catch (error) {
			console.error("[quillstone] échec de l'import PDF :", error);
			notice.hide();
			new Notice("Couldn't import this PDF.");
		}
	}

	/**
	 * Bouton « Exporter en PDF » de la barre d'outils (voir buildToolbar) :
	 * rend CHAQUE page du document (fond, traits, formes, images comprises —
	 * voir renderScene), y compris celles hors du champ visible actuel (pas
	 * seulement la plage virtualisée du volet, voir visiblePageRange), sur un
	 * canvas dédié à résolution PDF_EXPORT_SCALE, puis assemble le tout en un
	 * PDF (voir pdfExport.ts) écrit à côté de cette feuille sous le même nom.
	 * Comme preview.ts:renderCached, une seule passe de rendu par page :
	 * attend d'abord que toutes ses images soient chargées (waitFor), jamais
	 * de "en cours de chargement" figé dans l'export. Couleurs toujours en
	 * mode clair (voir resolveColors) quel que soit le thème actif ou le
	 * réglage « Papier toujours clair » : un PDF destiné à l'impression ou au
	 * partage ne doit jamais hériter d'un fond sombre.
	 */
	private async exportToPdf(): Promise<void> {
		if (!this.file) {
			new Notice("Can't export: this sheet hasn't been saved yet.");
			return;
		}

		const notice = new Notice("Exporting to PDF…", 0);
		try {
			const colors = resolveColors(this.containerEl, true);
			const exportPages: ExportPage[] = [];

			for (let i = 0; i < this.doc.pages.length; i++) {
				notice.setMessage(`Exporting to PDF… page ${i + 1}/${this.doc.pages.length}`);
				const page = this.doc.pages[i];

				const imageElements = page.elements.filter((el): el is ImageElement => el.type === "image");
				await Promise.all(imageElements.map((el) => this.imageCache.waitFor(el, this.doc.pdfSources)));

				const canvas = document.createElement("canvas");
				canvas.width = Math.max(1, Math.round(page.width * PDF_EXPORT_SCALE));
				canvas.height = Math.max(1, Math.round(page.height * PDF_EXPORT_SCALE));
				const ctx = canvas.getContext("2d");
				if (!ctx) throw new Error("Canvas 2D unavailable");
				ctx.setTransform(PDF_EXPORT_SCALE, 0, 0, PDF_EXPORT_SCALE, 0, 0);
				renderScene(ctx, page, colors, { resolveImage: (el) => this.imageCache.get(el, this.doc.pdfSources) });

				exportPages.push({ canvas, width: page.width, height: page.height });
			}

			const blob = buildPdfFromPages(exportPages);
			const folder = this.file.parent instanceof TFolder ? this.file.parent.path : "";
			const pdfPath = this.plugin.uniqueVaultPath(folder, this.file.basename, "pdf");
			const pdfFile = await this.app.vault.createBinary(pdfPath, await blob.arrayBuffer());

			notice.hide();
			new Notice(`Export complete: ${pdfFile.path}`);
			await this.app.workspace.getLeaf("tab").openFile(pdfFile);
		} catch (error) {
			console.error("[quillstone] échec de l'export PDF :", error);
			notice.hide();
			const tooLarge = error instanceof Error && /too large to export/.test(error.message);
			new Notice(
				tooLarge
					? "Couldn't export this sheet to PDF: it's too large (too many pages and/or scanned backgrounds). Try exporting fewer pages at a time."
					: "Couldn't export this sheet to PDF."
			);
		}
	}

	/**
	 * Retire la page `pageIndex` du document. Toujours précédé d'une
	 * confirmation si elle contient des éléments (voir requestDeletePage) ;
	 * cette méthode-ci ne revérifie rien, elle applique. Décale les index de
	 * la sélection courante et de l'historique (voir History.removePage)
	 * pour qu'ils continuent de désigner la bonne page après le retrait.
	 */
	private deletePage(pageIndex: number): void {
		if (pageIndex < 0 || pageIndex >= this.pages.length || this.pages.length <= 1) return;

		const rt = this.pages[pageIndex];
		if (rt.committedRedrawHandle !== null) window.cancelAnimationFrame(rt.committedRedrawHandle);

		this.doc.pages.splice(pageIndex, 1);
		this.pages.splice(pageIndex, 1);
		this.history.removePage(pageIndex);

		if (this.selectedPageIndex === pageIndex) {
			this.selectedIds.clear();
			this.selectedPageIndex = null;
		} else if (this.selectedPageIndex !== null && this.selectedPageIndex > pageIndex) {
			this.selectedPageIndex -= 1;
		}
		if (this.focusedPageIndex >= this.pages.length) this.focusedPageIndex = this.pages.length - 1;
		if (this.hoveredPageIndex !== null && this.hoveredPageIndex >= this.pages.length) this.hoveredPageIndex = null;

		this.updateHistoryButtons();
		this.updateSelectionActionsToolbar();
		this.requestSave();
		this.layoutPages();
		this.redrawViewport();
	}

	/**
	 * Point d'entrée du bouton de suppression (survol, voir pageDeleteBtn) et
	 * de l'entrée « Supprimer cette page » du menu contextuel : refuse de
	 * supprimer la dernière page restante (une feuille en garde toujours au
	 * moins une), et demande confirmation si la page contient des éléments —
	 * jamais pour une page vide, où il n'y a rien à perdre.
	 */
	private requestDeletePage(pageIndex: number): void {
		if (this.pages.length <= 1) {
			new Notice("Can't delete the last page: a sheet always keeps at least one page.");
			return;
		}
		const rt = this.pages[pageIndex];
		if (!rt) return;
		if (rt.page.elements.length > 0) {
			const count = rt.page.elements.length;
			const ok = window.confirm(
				`Delete this page? It contains ${count} element${count > 1 ? "s" : ""}, which will be permanently lost.`
			);
			if (!ok) return;
		}
		this.deletePage(pageIndex);
	}

	/**
	 * Déplace la page `fromIndex` à la position `toIndex` (0-indexée, déjà
	 * bornée à [0, pages.length-1] par l'appelant — voir promptMovePage) :
	 * mêmes deux `splice()` que `doc.pages.splice(fromIndex, 1)` suivi de
	 * `doc.pages.splice(toIndex, 0, page)`, sur `doc.pages` ET `pages` (état
	 * de rendu) en parallèle pour qu'ils restent synchronisés (voir
	 * PageRuntime). L'historique et les index de sélection/focus suivent la
	 * même règle que History.movePage (voir remapPageIndex, history.ts) —
	 * jamais dupliquée ici.
	 */
	private movePageTo(fromIndex: number, toIndex: number): void {
		if (fromIndex < 0 || fromIndex >= this.pages.length) return;
		toIndex = clamp(toIndex, 0, this.pages.length - 1);
		if (fromIndex === toIndex) return;

		const [page] = this.doc.pages.splice(fromIndex, 1);
		this.doc.pages.splice(toIndex, 0, page);
		const [rt] = this.pages.splice(fromIndex, 1);
		this.pages.splice(toIndex, 0, rt);
		this.history.movePage(fromIndex, toIndex);

		if (this.selectedPageIndex !== null) {
			this.selectedPageIndex = remapPageIndex(this.selectedPageIndex, fromIndex, toIndex);
		}
		this.focusedPageIndex = remapPageIndex(this.focusedPageIndex, fromIndex, toIndex);
		this.hoveredPageIndex = null;

		this.layoutPages();
		this.updateHistoryButtons();
		this.requestSave();
		this.redrawViewport();
		this.scrollToPage(toIndex);
	}

	/**
	 * Point d'entrée du bouton « Déplacer » (survol, voir pageMoveBtn) :
	 * demande la position de destination via MovePageModal — PAS
	 * `window.prompt()`, qu'Electron n'implémente pas (l'appel se comporte
	 * comme une annulation immédiate, sans jamais rien afficher : c'est ce
	 * qui rendait ce bouton silencieusement inopérant). Numéro affiché et
	 * saisi 1-indexé (ce que voit l'utilisateur), converti en index 0-indexé
	 * pour movePageTo(). Une saisie annulée ou hors limites laisse la page où
	 * elle est plutôt que de la déplacer au hasard.
	 */
	private promptMovePage(pageIndex: number): void {
		const total = this.pages.length;
		if (total <= 1) return;

		new MovePageModal(this.app, pageIndex + 1, total, (target) => this.movePageTo(pageIndex, target - 1)).open();
	}

	// --- Cycle de vie ---------------------------------------------------------

	async onOpen(): Promise<void> {
		// Écrase l'outil courant par l'outil par défaut des réglages — voir
		// QuillStoneSettings.defaultTool — une seule fois, à la création de
		// cette vue. Fait exprès ici plutôt que dans setViewData() : onOpen()
		// ne s'exécute qu'une fois par vue, alors que setViewData() peut être
		// rappelée plus tard pour la même vue (rechargement suite à une
		// modification externe, y compris son propre enregistrement
		// debattu par requestSave()) — l'y placer réinitialisait l'outil actif
		// en cours d'usage, sans aucun clic sur la barre d'outils.
		this.plugin.settings.tool = this.plugin.settings.defaultTool;

		this.contentEl.empty();
		this.contentEl.addClass("quillstone-content");
		// Rend le conteneur focusable (voir onPointerDown, qui le focalise au clic).
		this.contentEl.tabIndex = 0;

		this.imageCache = new ImageElementCache(this.app, () => this.onImageLoaded());
		// Une page importée référence un PDF (voir ImageElement.pdfPage), rendu
		// à la demande par imageCache dès qu'elle entre dans le champ — pas
		// seulement au moment de l'import : redondant avec l'appel équivalent
		// dans DrawPreviewManager (déjà fait au chargement du plugin), mais
		// gratuit (idempotent, voir pdf.ts) et rend cette vue autonome plutôt
		// que dépendante de l'ordre d'initialisation d'une autre classe.
		this.plugin.ensurePdfWorkerConfigured();
		this.rebuildPageRuntimes();

		this.scope = new Scope(this.app.scope);
		this.scope.register(["Mod"], "z", (evt) => {
			evt.preventDefault();
			this.undo();
			return false;
		});
		this.scope.register(["Mod", "Shift"], "z", (evt) => {
			evt.preventDefault();
			this.redo();
			return false;
		});
		this.scope.register(["Mod"], "v", (evt) => {
			evt.preventDefault();
			void this.pasteFromClipboard();
			return false;
		});

		// Opérations sur la sélection : n'agissent (et n'interceptent la touche)
		// que si une sélection existe réellement — sinon on laisse le
		// raccourci filer sans effet, plutôt que de le "consommer" pour rien.
		this.scope.register([], "Delete", (evt) => {
			if (this.selectedIds.size === 0) return;
			evt.preventDefault();
			this.deleteSelection();
			return false;
		});
		this.scope.register([], "Backspace", (evt) => {
			if (this.selectedIds.size === 0) return;
			evt.preventDefault();
			this.deleteSelection();
			return false;
		});
		this.scope.register(["Mod"], "c", (evt) => {
			if (this.selectedIds.size === 0) return;
			evt.preventDefault();
			this.copySelectionToClipboard();
			return false;
		});
		this.scope.register(["Mod"], "x", (evt) => {
			if (this.selectedIds.size === 0) return;
			evt.preventDefault();
			this.cutSelection();
			return false;
		});
		this.scope.register(["Mod"], "d", (evt) => {
			if (this.selectedIds.size === 0) return;
			evt.preventDefault();
			this.duplicateSelection();
			return false;
		});
		this.scope.register(["Mod"], "a", (evt) => {
			if (!isSelectionTool(this.plugin.settings.tool)) return;
			evt.preventDefault();
			this.selectAll();
			return false;
		});
		this.scope.register([], "Escape", (evt) => {
			if (this.selectedIds.size === 0) return;
			evt.preventDefault();
			this.clearSelection();
			return false;
		});
		this.scope.register([], "ArrowLeft", (evt) => this.handleSelectionNudgeKey(evt, -1, 0));
		this.scope.register([], "ArrowRight", (evt) => this.handleSelectionNudgeKey(evt, 1, 0));
		this.scope.register([], "ArrowUp", (evt) => this.handleSelectionNudgeKey(evt, 0, -1));
		this.scope.register([], "ArrowDown", (evt) => this.handleSelectionNudgeKey(evt, 0, 1));

		this.buildToolbar();

		this.wrapper = this.contentEl.createDiv({ cls: "quillstone-wrapper" });
		this.committedCanvas = this.wrapper.createEl("canvas", {
			cls: "quillstone-canvas quillstone-canvas-committed",
		});
		this.activeCanvas = this.wrapper.createEl("canvas", {
			cls: "quillstone-canvas quillstone-canvas-active",
		});

		const committedCtx = this.committedCanvas.getContext("2d");
		const activeCtx = this.activeCanvas.getContext("2d");
		if (!committedCtx || !activeCtx) throw new Error("Canvas 2D indisponible");
		this.committedCtx = committedCtx;
		this.activeCtx = activeCtx;

		// this.pages est déjà peuplé (rebuildPageRuntimes() plus haut dans
		// onOpen) mais layoutPages() ne pouvait pas encore créer les boutons
		// « + » : le wrapper n'existait pas. Un seul rattrapage ici suffit,
		// les changements ultérieurs du nombre de pages passent tous par
		// layoutPages().
		this.syncAddPageButtons();

		// Boutons uniques repositionnés sur la page survolée (voir
		// updateHoverPageButtons) plutôt qu'un bouton par page : plus simple
		// que de gérer l'apparition au survol sur autant d'éléments qu'il y a
		// de pages visibles, pour un résultat identique.
		this.pageDeleteBtn = this.wrapper.createDiv({ cls: "quillstone-page-delete-btn clickable-icon" });
		setIcon(this.pageDeleteBtn, "trash-2");
		this.pageDeleteBtn.setAttribute("role", "button");
		this.pageDeleteBtn.setAttribute("aria-label", "Delete page");
		setTooltip(this.pageDeleteBtn, "Delete page");
		this.pageDeleteBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			if (this.hoveredPageIndex !== null) this.requestDeletePage(this.hoveredPageIndex);
		});
		this.pageDeleteBtn.hide();

		this.pageMoveBtn = this.wrapper.createDiv({ cls: "quillstone-page-move-btn clickable-icon" });
		setIcon(this.pageMoveBtn, "move-vertical");
		this.pageMoveBtn.setAttribute("role", "button");
		this.pageMoveBtn.setAttribute("aria-label", "Move this page to…");
		setTooltip(this.pageMoveBtn, "Move this page to… (or drag it to a gap)");
		this.pageMoveBtn.addEventListener("click", (evt) => {
			evt.stopPropagation();
			if (this.hoveredPageIndex !== null) this.promptMovePage(this.hoveredPageIndex);
		});
		// Poignée de glisser-déposer : voir dragSourcePageIndex et
		// createAddPageButton (cibles de dépôt, un par interstice).
		this.pageMoveBtn.draggable = true;
		this.pageMoveBtn.addEventListener("dragstart", (evt) => {
			if (this.hoveredPageIndex === null) return;
			this.dragSourcePageIndex = this.hoveredPageIndex;
			evt.dataTransfer?.setData("text/plain", String(this.hoveredPageIndex));
			if (evt.dataTransfer) evt.dataTransfer.effectAllowed = "move";
		});
		this.pageMoveBtn.addEventListener("dragend", () => {
			this.dragSourcePageIndex = null;
		});
		this.pageMoveBtn.hide();

		this.committedCanvas.addEventListener("pointerdown", this.onPointerDown);
		this.committedCanvas.addEventListener("pointermove", this.onPointerMove);
		this.committedCanvas.addEventListener("pointerup", this.onPointerUp);
		this.committedCanvas.addEventListener("pointercancel", this.onPointerCancel);
		this.committedCanvas.addEventListener("pointerleave", this.onPointerLeave);
		// Sur contentEl (pas committedCanvas) : la molette zoome/panoramique
		// aussi quand le pointeur survole la barre d'outils, au-dessus du
		// canevas — pas seulement la feuille elle-même. onWheel calcule son
		// point d'ancrage depuis le rectangle du canevas indépendamment de
		// l'élément qui a reçu l'événement, ça reste valable même hors de ses
		// limites.
		this.contentEl.addEventListener("wheel", this.onWheel, { passive: false });
		this.committedCanvas.addEventListener("contextmenu", this.onContextMenu);
		window.addEventListener("keydown", this.onWindowKeyDown);
		window.addEventListener("keyup", this.onWindowKeyUp);

		this.resizeObserver = new ResizeObserver(() => {
			// Un redimensionnement de fenêtre change la taille du volet visible
			// (donc les deux canvas), mais jamais les caches : ils restent
			// valables tant que l'échelle effective n'a pas changé, voir
			// regeneratePageCache().
			if (this.resizeCanvas()) this.scheduleViewportRedraw();
		});
		this.resizeObserver.observe(this.wrapper);

		this.resizeCanvas();
		if (!this.viewportRestored) this.fitToWindow();
		this.render();
	}

	async onClose(): Promise<void> {
		this.resizeObserver?.disconnect();
		if (this.cacheRegenTimeout !== null) window.clearTimeout(this.cacheRegenTimeout);
		for (const rt of this.pages) {
			if (rt.committedRedrawHandle !== null) window.cancelAnimationFrame(rt.committedRedrawHandle);
		}
		this.resetStraightLineState();
		this.clearLongPressMenu();
		if (this.laserAnimHandle !== null) window.cancelAnimationFrame(this.laserAnimHandle);
		this.imageCache?.clear();
		this.committedCanvas?.removeEventListener("pointerdown", this.onPointerDown);
		this.committedCanvas?.removeEventListener("pointermove", this.onPointerMove);
		this.committedCanvas?.removeEventListener("pointerup", this.onPointerUp);
		this.committedCanvas?.removeEventListener("pointercancel", this.onPointerCancel);
		this.committedCanvas?.removeEventListener("pointerleave", this.onPointerLeave);
		this.contentEl.removeEventListener("wheel", this.onWheel);
		this.committedCanvas?.removeEventListener("contextmenu", this.onContextMenu);
		window.removeEventListener("keydown", this.onWindowKeyDown);
		window.removeEventListener("keyup", this.onWindowKeyUp);
		this.contentEl.empty();
	}

	// --- Rendu ----------------------------------------------------------------

	/**
	 * Les deux canvas visibles sont dimensionnés sur le volet (pas sur une
	 * page — voir Viewport) : un redimensionnement de fenêtre ne doit donc
	 * jamais régénérer les caches, seulement redessiner la fenêtre courante
	 * dessus. Assigner canvas.width/height VIDE le canvas même en
	 * réassignant la même valeur : on ne le fait donc que si la résolution a
	 * vraiment changé. Renvoie vrai si un redessin est nécessaire.
	 */
	private resizeCanvas(): boolean {
		if (!this.committedCanvas || !this.activeCanvas || !this.wrapper) return false;

		const dpr = window.devicePixelRatio || 1;
		const rect = this.wrapper.getBoundingClientRect();
		const w = Math.max(1, Math.round(rect.width * dpr));
		const h = Math.max(1, Math.round(rect.height * dpr));

		if (this.committedCanvas.width === w && this.committedCanvas.height === h) {
			return false;
		}

		this.committedCanvas.width = w;
		this.committedCanvas.height = h;
		this.activeCanvas.width = w;
		this.activeCanvas.height = h;
		return true;
	}

	/**
	 * Avec le réglage « Papier toujours clair » (activé par défaut), le papier
	 * ignore le thème et reste sur les valeurs claires fixes définies dans
	 * styles.css (--qs-paper-light / --qs-rule-light) : c'est le seul moyen
	 * d'obtenir un surlignage fiable, sans dépendre de la détection de
	 * luminance. Sinon, comportement habituel : le papier suit le thème actif.
	 * Partagé avec les aperçus intégrés dans les notes (voir colors.ts).
	 */
	private currentColors(): RenderColors {
		return resolveColors(this.containerEl, this.plugin.settings.paperAlwaysLight);
	}

	/** Passé à renderScene comme `resolveImage` : render.ts ne connaît pas le coffre, ce pont-ci le lui fournit sans jamais relire le fichier lui-même (voir imageCache.ts). Propriété liée (pas une méthode) pour rester une référence stable au fil des rendus. */
	private resolveImage = (el: ImageElement): ImageResolution => this.imageCache.get(el, this.doc.pdfSources);

	/** Une image vient de finir de charger (ou d'échouer) : le cache d'une page construite avec l'état précédent (« en cours de chargement ») est donc invalide. On ne sait pas ici laquelle des pages référence ce chemin (voir imageCache.ts, partagé par toutes) : toutes sont marquées à régénérer, mais seules celles réellement visibles le seront tout de suite (voir redrawViewport) — les autres se rattraperont en entrant dans la plage visible. */
	private onImageLoaded(): void {
		this.render();
	}

	// --- Coordonnées -------------------------------------------------------------

	/**
	 * Repère écran (relatif au canvas) -> repère document : le repère
	 * partagé par toutes les pages empilées (voir layoutPages), avant toute
	 * conversion vers le repère local d'une page précise. Seule fonction du
	 * plugin à interpréter directement viewport.scale/offsetX/offsetY.
	 */
	private screenToDocument(sx: number, sy: number): [number, number] {
		return [(sx - this.viewport.offsetX) / this.viewport.scale, (sy - this.viewport.offsetY) / this.viewport.scale];
	}

	/** L'inverse de screenToDocument(). */
	private documentToScreen(dx: number, dy: number): [number, number] {
		return [this.viewport.offsetX + dx * this.viewport.scale, this.viewport.offsetY + dy * this.viewport.scale];
	}

	/** Quelle page (s'il y en a une) contient ce point du repère document — parcourt les pages dans l'ordre, leurs rectangles ne se recouvrant jamais (voir layoutPages, séparées par PAGE_GAP). `null` si le point tombe dans la marge entre deux pages, ou hors de toute page. */
	private hitPage(docX: number, docY: number): number | null {
		for (let i = 0; i < this.pages.length; i++) {
			const rt = this.pages[i];
			if (docX >= rt.originX && docX <= rt.originX + rt.page.width && docY >= rt.originY && docY <= rt.originY + rt.page.height) {
				return i;
			}
		}
		return null;
	}

	/**
	 * Comme hitPage, mais élargi de PAGE_HOVER_MARGIN_PX sur le bord droit —
	 * exclusivement pour le suivi de survol qui pilote hoveredPageIndex (voir
	 * onPointerMove). Le bouton de suppression vit dans cette marge, en
	 * dehors de la page (voir updateHoverPageButtons) : sans cet
	 * élargissement, traverser la marge pour l'atteindre ferait retomber
	 * hoveredPageIndex à `null` avant même d'y arriver, et le bouton
	 * disparaîtrait sous le curseur qui tente de le rejoindre. Ne sert
	 * jamais à un geste de dessin ou de sélection, seulement à savoir quelle
	 * page « compte » comme survolée pour l'interface.
	 */
	private hitPageForHover(docX: number, docY: number): number | null {
		for (let i = 0; i < this.pages.length; i++) {
			const rt = this.pages[i];
			if (
				docX >= rt.originX &&
				docX <= rt.originX + rt.page.width + PAGE_HOVER_MARGIN_PX &&
				docY >= rt.originY &&
				docY <= rt.originY + rt.page.height
			) {
				return i;
			}
		}
		return null;
	}

	/** Repère document -> repère local de `pageIndex` (son coin haut-gauche devient l'origine). */
	private toPageLocal(pageIndex: number, docX: number, docY: number): [number, number] {
		const rt = this.pages[pageIndex];
		return [docX - rt.originX, docY - rt.originY];
	}

	/** Repère local de `pageIndex` -> repère document. L'inverse de toPageLocal(). */
	private pageToDocument(pageIndex: number, x: number, y: number): [number, number] {
		const rt = this.pages[pageIndex];
		return [x + rt.originX, y + rt.originY];
	}

	/** Repère local de `pageIndex` -> repère écran, en un seul appel (composé de pageToDocument + documentToScreen) — ce que logicalToScreen faisait dans l'ancienne version à page unique du plugin. */
	private pageToScreen(pageIndex: number, x: number, y: number): [number, number] {
		const [dx, dy] = this.pageToDocument(pageIndex, x, y);
		return this.documentToScreen(dx, dy);
	}

	/**
	 * Combine l'échelle de la vue, le décalage de `pageIndex` dans le repère
	 * document et le devicePixelRatio en une seule transformation, appliquée
	 * avant tout dessin PAGE-LOCAL — c'est l'unique endroit où le repère
	 * local d'une page est converti en pixels d'écran pour du dessin canvas
	 * (voir aussi pageToScreen, l'équivalent pour positionner un élément
	 * d'interface plutôt que dessiner directement).
	 */
	private applyPageViewTransform(ctx: CanvasRenderingContext2D, pageIndex: number): void {
		const dpr = window.devicePixelRatio || 1;
		const rt = this.pages[pageIndex];
		const scale = this.viewport.scale;
		ctx.setTransform(
			scale * dpr,
			0,
			0,
			scale * dpr,
			(this.viewport.offsetX + rt.originX * scale) * dpr,
			(this.viewport.offsetY + rt.originY * scale) * dpr
		);
	}

	/**
	 * Point d'entrée unique après toute modification du modèle : invalide le
	 * cache d'UNE page (celle qui a changé — l'immense majorité des
	 * modifications ne touchent qu'à une seule page à la fois) et redessine.
	 * Sans argument, invalide TOUTES les pages (chargement du document,
	 * réglage de rendu global comme highlighterAlwaysBehind) — leur
	 * régénération réelle reste paresseuse (voir redrawViewport), seules les
	 * pages visibles sont immédiatement retracées.
	 */
	render(pageIndex?: number): void {
		if (pageIndex === undefined) {
			for (const rt of this.pages) rt.cacheDirty = true;
		} else {
			const rt = this.pages[pageIndex];
			if (rt) {
				rt.cacheDirty = true;
				rt.dirtyBounds = null;
			}
		}
		this.layoutPages();
		this.redrawViewport();
	}

	/** Première et dernière page dont le cache doit rester à jour : celles qui recoupent le volet visible, plus VIRTUALIZE_MARGIN_PAGES de chaque côté (voir la fonctionnalité « pages multiples » — indispensable dès qu'un cahier dépasse une dizaine de pages). `last < first` (plage vide) si rien n'est visible. */
	private visiblePageRange(): { first: number; last: number } {
		if (this.pages.length === 0 || !this.wrapper) return { first: 0, last: -1 };
		const rect = this.wrapper.getBoundingClientRect();
		const [, topDocY] = this.screenToDocument(0, 0);
		const [, bottomDocY] = this.screenToDocument(0, rect.height);

		let first = -1;
		let last = -1;
		for (let i = 0; i < this.pages.length; i++) {
			const rt = this.pages[i];
			if (rt.originY + rt.page.height < topDocY || rt.originY > bottomDocY) continue;
			if (first === -1) first = i;
			last = i;
		}
		if (first === -1) return { first: 0, last: -1 };
		return {
			first: Math.max(0, first - VIRTUALIZE_MARGIN_PAGES),
			last: Math.min(this.pages.length - 1, last + VIRTUALIZE_MARGIN_PAGES),
		};
	}

	/**
	 * Redessine entièrement le cache hors écran d'UNE page (voir
	 * PageRuntime.cacheCanvas) depuis son modèle. Coûteux (retrace tous ses
	 * traits) : n'est appelée que pour une page marquée `cacheDirty`, et
	 * seulement quand elle entre dans la plage visible (voir redrawViewport)
	 * — jamais pour les pages hors champ.
	 */
	private regeneratePageCache(pageIndex: number): void {
		const rt = this.pages[pageIndex];
		if (!rt) return;

		const dpr = window.devicePixelRatio || 1;
		const targetScale = Math.min(this.viewport.scale * dpr, MAX_CACHE_SCALE);
		rt.cacheScale = targetScale;

		const w = Math.max(1, Math.round(rt.page.width * targetScale));
		const h = Math.max(1, Math.round(rt.page.height * targetScale));
		if (rt.cacheCanvas.width !== w || rt.cacheCanvas.height !== h) {
			rt.cacheCanvas.width = w;
			rt.cacheCanvas.height = h;
		}
		rt.cacheCtx.setTransform(targetScale, 0, 0, targetScale, 0, 0);
		renderScene(rt.cacheCtx, rt.page, this.currentColors(), {
			highlighterBehind: this.plugin.settings.highlighterAlwaysBehind,
			resolveImage: this.resolveImage,
		});
		rt.cacheDirty = false;
		rt.dirtyBounds = null;
	}

	/**
	 * Redessin régional pendant un geste de gomme sur `pageIndex` : ne
	 * régénère que la zone accumulée depuis le dernier flush (fond + traits
	 * qui la recoupent) DANS le cache de CETTE page, jamais toute la page.
	 * La régénération complète n'a lieu qu'au pointerup (voir
	 * finishEraseZone/finishEraseStroke, qui appellent render() directement).
	 */
	private markErasedRegion(pageIndex: number, bounds: StrokeBounds, strokeSize: number): void {
		const rt = this.pages[pageIndex];
		if (!rt) return;
		const pad = strokeSize + ERASE_DIRTY_PADDING;
		const padded: StrokeBounds = {
			minX: bounds.minX - pad,
			minY: bounds.minY - pad,
			maxX: bounds.maxX + pad,
			maxY: bounds.maxY + pad,
		};
		rt.dirtyBounds = rt.dirtyBounds
			? {
					minX: Math.min(rt.dirtyBounds.minX, padded.minX),
					minY: Math.min(rt.dirtyBounds.minY, padded.minY),
					maxX: Math.max(rt.dirtyBounds.maxX, padded.maxX),
					maxY: Math.max(rt.dirtyBounds.maxY, padded.maxY),
			  }
			: padded;
	}

	private flushCommittedRedraw(pageIndex: number): void {
		const rt = this.pages[pageIndex];
		if (!rt) return;
		const clip = rt.dirtyBounds;
		rt.dirtyBounds = null;
		rt.cacheCtx.setTransform(rt.cacheScale, 0, 0, rt.cacheScale, 0, 0);
		renderScene(rt.cacheCtx, rt.page, this.currentColors(), {
			highlighterBehind: this.plugin.settings.highlighterAlwaysBehind,
			clip: clip ?? undefined,
			resolveImage: this.resolveImage,
		});
		this.redrawViewport();
	}

	/** Version throttled de flushCommittedRedraw() : au plus une fois par frame par page, quel que soit le nombre d'événements pointeur reçus entre-temps. */
	private scheduleCommittedRedraw(pageIndex: number): void {
		const rt = this.pages[pageIndex];
		if (!rt || rt.committedRedrawHandle !== null) return;
		rt.committedRedrawHandle = window.requestAnimationFrame(() => {
			rt.committedRedrawHandle = null;
			this.flushCommittedRedraw(pageIndex);
		});
	}

	/** Annule un redessin régional encore en attente pour `pageIndex` : utilisé en fin de geste, juste avant le render() complet qui le rend inutile. */
	private cancelScheduledCommittedRedraw(pageIndex: number): void {
		const rt = this.pages[pageIndex];
		if (!rt) return;
		if (rt.committedRedrawHandle !== null) {
			window.cancelAnimationFrame(rt.committedRedrawHandle);
			rt.committedRedrawHandle = null;
		}
		rt.dirtyBounds = null;
	}

	/**
	 * Recopie chaque page de la plage visible (voir visiblePageRange) — à sa
	 * bonne place dans le repère document — sur la fenêtre visible, en
	 * régénérant d'abord son cache si besoin (voir regeneratePageCache). Les
	 * pages hors de cette plage ne sont ni régénérées ni recopiées : c'est ce
	 * qui rend le défilement bon marché même sur un cahier de plusieurs
	 * dizaines de pages.
	 */
	private redrawViewport(): void {
		if (!this.committedCtx || !this.committedCanvas) return;
		const ctx = this.committedCtx;
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this.committedCanvas.width, this.committedCanvas.height);
		ctx.restore();

		const range = this.visiblePageRange();
		for (let i = range.first; i <= range.last; i++) {
			const rt = this.pages[i];
			if (!rt) continue;
			if (rt.cacheDirty) this.regeneratePageCache(i);
			ctx.save();
			this.applyPageViewTransform(ctx, i);
			ctx.drawImage(rt.cacheCanvas, 0, 0, rt.page.width, rt.page.height);
			ctx.restore();
		}

		this.updateAddPageButtonsPositions();
		this.updateHoverPageButtons();
		this.updatePageIndicator();
	}

	private scheduleViewportRedraw(): void {
		if (this.viewportRedrawScheduled) return;
		this.viewportRedrawScheduled = true;
		window.requestAnimationFrame(() => {
			this.viewportRedrawScheduled = false;
			this.redrawViewport();
		});
	}

	/** Repositionne chaque bouton rond « + », centré dans l'interstice sous la page qui lui correspond (voir addPageBtns/syncAddPageButtons), dans le repère écran courant — recalculé à chaque redessin du volet (zoom, panoramique, ajout/suppression de page). */
	private updateAddPageButtonsPositions(): void {
		for (let i = 0; i < this.addPageBtns.length; i++) {
			const rt = this.pages[i];
			if (!rt) continue;
			const cx = rt.originX + rt.page.width / 2;
			const cy = rt.originY + rt.page.height + PAGE_GAP / 2;
			const [sx, sy] = this.documentToScreen(cx, cy);
			this.addPageBtns[i].setCssStyles({ left: `${sx}px`, top: `${sy}px` });
		}
	}

	/**
	 * Positionne (ou masque) les boutons discrets de suppression et de
	 * déplacement à droite de la page actuellement survolée, EN DEHORS de la
	 * feuille (voir PAGE_DELETE_BTN_OUTSET) — jamais superposés au contenu,
	 * donc jamais dans le chemin d'un tracé ou d'un clic sur la page. Le
	 * bouton « Déplacer » est empilé juste au-dessus de celui de suppression
	 * (voir PAGE_MOVE_BTN_GAP). Suivis via hoveredPageIndex, mis à jour par
	 * onPointerMove ; jamais affichés s'il n'y a qu'une seule page, puisque
	 * ni la supprimer (voir requestDeletePage) ni la déplacer n'a de sens.
	 */
	private updateHoverPageButtons(): void {
		if (!this.pageDeleteBtn || !this.pageMoveBtn) return;
		if (this.hoveredPageIndex === null || this.pages.length <= 1 || !this.pages[this.hoveredPageIndex]) {
			this.pageDeleteBtn.hide();
			this.pageMoveBtn.hide();
			return;
		}
		const rt = this.pages[this.hoveredPageIndex];
		const x = rt.originX + rt.page.width + PAGE_DELETE_BTN_OUTSET;
		const centerY = rt.originY + rt.page.height / 2;

		const [dsx, dsy] = this.documentToScreen(x, centerY);
		this.pageDeleteBtn.setCssStyles({ left: `${dsx}px`, top: `${dsy}px` });
		this.pageDeleteBtn.show();

		const [msx, msy] = this.documentToScreen(x, centerY - PAGE_MOVE_BTN_GAP);
		this.pageMoveBtn.setCssStyles({ left: `${msx}px`, top: `${msy}px` });
		this.pageMoveBtn.show();
	}

	private clearActiveCanvasFull(): void {
		if (!this.activeCtx || !this.activeCanvas) return;
		this.activeCtx.save();
		this.activeCtx.setTransform(1, 0, 0, 1, 0, 0);
		this.activeCtx.clearRect(0, 0, this.activeCanvas.width, this.activeCanvas.height);
		this.activeCtx.restore();
	}

	private scheduleActiveRedraw(): void {
		if (this.activeRedrawScheduled) return;
		this.activeRedrawScheduled = true;
		window.requestAnimationFrame(() => {
			this.activeRedrawScheduled = false;
			this.redrawActiveCanvas();
		});
	}

	/**
	 * Le canvas « en cours » est entièrement redessiné à chaque frame, jamais
	 * peint morceau par morceau — mais « entièrement » ne veut pas dire
	 * régénérer un cache : dans le cas normal, le trait en cours est
	 * forcément le plus récent, donc toujours au-dessus en ordre
	 * chronologique. Il suffit de recopier ce qui est déjà affiché sur le
	 * canvas validé (copie 1:1, les deux canvas ont la même taille et le
	 * même cadrage) puis de peindre uniquement le trait en cours par-dessus,
	 * avec la transformation de SA page (voir activeStrokePageIndex).
	 *
	 * Seule exception : avec le réglage « Surligneur toujours en
	 * arrière-plan » actif, un trait de surligneur en cours doit s'intercaler
	 * sous des traits de stylo déjà validés, ce qu'un simple calque
	 * par-dessus ne peut pas représenter. Cette combinaison précise (rare,
	 * optionnelle) retombe donc sur un rendu complet de la scène de cette
	 * page, plus coûteux mais correct.
	 */
	private redrawActiveCanvas(): void {
		if (!this.activeCtx) return;
		this.clearActiveCanvasFull();

		// Indépendant de l'outil actif : une traînée laser continue de
		// s'estomper après un relâchement, voire après un changement d'outil
		// si setTool() ne l'a pas vidée entre-temps — dessinée en repère
		// écran, jamais celui d'une page (voir laserPoints).
		this.drawLaserTrail();

		if (this.activeStroke && this.activeStrokePageIndex !== null) {
			const pageIndex = this.activeStrokePageIndex;
			const rt = this.pages[pageIndex];
			const colors = this.currentColors();

			if (this.recognizedShape) {
				// Une forme a été reconnue : le tracé au stylo/surligneur en
				// cours n'est plus qu'un brouillon invisible, seul son aperçu
				// nettoyé compte à l'écran (voir triggerHoldConversion).
				this.activeCtx.save();
				this.activeCtx.setTransform(1, 0, 0, 1, 0, 0);
				this.activeCtx.drawImage(this.committedCanvas, 0, 0);
				this.activeCtx.restore();

				this.applyPageViewTransform(this.activeCtx, pageIndex);
				drawElement(this.activeCtx, this.recognizedShape, rt.page.width, rt.page.height, colors.paper);
			} else {
				const needsFullOrdering =
					this.plugin.settings.highlighterAlwaysBehind && this.activeStroke.tool === "highlighter";

				if (needsFullOrdering) {
					this.applyPageViewTransform(this.activeCtx, pageIndex);
					renderScene(this.activeCtx, rt.page, colors, {
						elements: [...rt.page.elements, this.activeStroke],
						highlighterBehind: true,
						resolveImage: this.resolveImage,
					});
				} else {
					this.activeCtx.save();
					this.activeCtx.setTransform(1, 0, 0, 1, 0, 0);
					this.activeCtx.drawImage(this.committedCanvas, 0, 0);
					this.activeCtx.restore();

					this.applyPageViewTransform(this.activeCtx, pageIndex);
					drawElement(this.activeCtx, this.activeStroke, rt.page.width, rt.page.height, colors.paper);
				}

				if (this.straightLine) {
					this.drawStraightenFlash();
					this.drawStraightLineHud(pageIndex);
				}
			}
		} else if (this.activeShape && this.activeShapePageIndex !== null) {
			const pageIndex = this.activeShapePageIndex;
			const rt = this.pages[pageIndex];
			const colors = this.currentColors();

			this.activeCtx.save();
			this.activeCtx.setTransform(1, 0, 0, 1, 0, 0);
			this.activeCtx.drawImage(this.committedCanvas, 0, 0);
			this.activeCtx.restore();

			this.applyPageViewTransform(this.activeCtx, pageIndex);
			drawElement(this.activeCtx, this.activeShape, rt.page.width, rt.page.height, colors.paper);
		} else if (
			this.plugin.settings.tool === "eraser-zone" &&
			this.eraserPreviewPoint &&
			this.eraserPreviewPageIndex !== null
		) {
			this.applyPageViewTransform(this.activeCtx, this.eraserPreviewPageIndex);
			this.drawEraserPreview();
		} else if (isSelectionTool(this.plugin.settings.tool)) {
			if (this.transformSession) {
				this.drawTransformPreview();
				this.drawSelectionOverlay(
					this.transformSession.pageIndex,
					DrawView.unionBounds(this.transformSession.currentTransformed)
				);
			} else if (this.activeMarquee) {
				this.applyPageViewTransform(this.activeCtx, this.activeMarquee.pageIndex);
				this.drawMarquee();
			} else if (this.selectedIds.size > 0 && this.selectedPageIndex !== null) {
				this.drawSelectionOverlay(this.selectedPageIndex, this.selectionBounds(), this.isSelectionTransformable());
			}
			this.drawLockIcons();
		} else if (this.plugin.settings.tool === "capture" && this.activeMarquee) {
			// Même aperçu en pointillés que le lasso/curseur (voir plus haut),
			// mais hors de la branche isSelectionTool : "capture" n'est pas un
			// outil de sélection (voir isSelectionTool) et n'a donc rien d'autre
			// à dessiner ici (pas de poignées, pas de cadenas).
			this.applyPageViewTransform(this.activeCtx, this.activeMarquee.pageIndex);
			this.drawMarquee();
		}
	}

	private drawEraserPreview(): void {
		if (!this.eraserPreviewPoint) return;
		const [x, y] = this.eraserPreviewPoint;
		const styles = getComputedStyle(this.containerEl);
		const color = styles.getPropertyValue("--text-muted").trim() || "#888888";

		const ctx = this.activeCtx;
		ctx.save();
		ctx.strokeStyle = color;
		ctx.lineWidth = 1;
		ctx.setLineDash([4, 3]);
		ctx.beginPath();
		ctx.arc(x, y, this.eraserRadius, 0, Math.PI * 2);
		ctx.stroke();
		ctx.restore();
	}

	/**
	 * Traînée du pointeur laser : un segment entre chaque paire de points
	 * consécutifs, opacité décroissante avec l'âge, plus un point plein sur
	 * le plus récent. Repère écran fixe (comme drawLockGlyph/drawStraightLineHud),
	 * jamais celui d'une page — l'épaisseur du trait ne doit pas varier avec
	 * le zoom, contrairement au dessin lui-même.
	 */
	private drawLaserTrail(): void {
		if (this.laserPoints.length === 0) return;
		const now = performance.now();
		const dpr = window.devicePixelRatio || 1;
		const ctx = this.activeCtx;

		ctx.save();
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.lineCap = "round";
		ctx.lineJoin = "round";

		for (let i = 1; i < this.laserPoints.length; i++) {
			const p1 = this.laserPoints[i];
			const alpha = Math.max(0, 1 - (now - p1.t) / LASER_FADE_MS);
			if (alpha <= 0) continue;
			const p0 = this.laserPoints[i - 1];
			const [x0, y0] = this.documentToScreen(p0.x, p0.y);
			const [x1, y1] = this.documentToScreen(p1.x, p1.y);
			ctx.strokeStyle = LASER_COLOR;
			ctx.globalAlpha = alpha * 0.85;
			ctx.lineWidth = 5;
			ctx.beginPath();
			ctx.moveTo(x0, y0);
			ctx.lineTo(x1, y1);
			ctx.stroke();
		}

		const last = this.laserPoints[this.laserPoints.length - 1];
		const alpha = Math.max(0, 1 - (now - last.t) / LASER_FADE_MS);
		if (alpha > 0) {
			const [x, y] = this.documentToScreen(last.x, last.y);
			ctx.globalAlpha = alpha;
			ctx.fillStyle = LASER_COLOR;
			ctx.beginPath();
			ctx.arc(x, y, 6, 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.restore();
	}

	/**
	 * S'anime indépendamment des événements pointeur, comme le halo de
	 * conversion en ligne droite (voir startStraightenFlash) — sans ça, un
	 * pointeur laser relâché (ou juste immobile) resterait figé à l'écran au
	 * lieu de s'estomper. Élague les points expirés à chaque frame ; s'arrête
	 * de lui-même une fois la traînée entièrement effacée.
	 */
	private scheduleLaserAnimation(): void {
		if (this.laserAnimHandle !== null) return;
		const tick = (): void => {
			const now = performance.now();
			this.laserPoints = this.laserPoints.filter((p) => now - p.t < LASER_FADE_MS);
			this.scheduleActiveRedraw();
			if (this.laserPoints.length === 0) {
				this.laserAnimHandle = null;
				return;
			}
			this.laserAnimHandle = window.requestAnimationFrame(tick);
		};
		this.laserAnimHandle = window.requestAnimationFrame(tick);
	}

	/**
	 * Pendant une transformation, la copie mise en cache une seule fois au
	 * début du geste (transformBgCanvas, sans les éléments sélectionnés) tient
	 * lieu d'arrière-plan — recopiée telle quelle à chaque frame, jamais
	 * régénérée. Seuls les quelques éléments sélectionnés, transformés, sont
	 * redessinés par-dessus.
	 */
	private drawTransformPreview(): void {
		const session = this.transformSession;
		if (!session || !this.transformBgCanvas) return;
		const rt = this.pages[session.pageIndex];
		const colors = this.currentColors();

		this.applyPageViewTransform(this.activeCtx, session.pageIndex);
		this.activeCtx.drawImage(this.transformBgCanvas, 0, 0, rt.page.width, rt.page.height);
		for (const el of session.currentTransformed) {
			drawElement(this.activeCtx, el, rt.page.width, rt.page.height, colors.paper, this.resolveImage);
		}
	}

	/** Pointillés animés pendant le geste (voir startMarqueeAnimation) — le rectangle se referme visuellement en trait plein, le lasso reste un chemin ouvert tant que le geste n'est pas terminé. Repère déjà celui de la page du lasso (voir applyPageViewTransform, appliqué par l'appelant). */
	private drawMarquee(): void {
		const shape = this.currentMarqueeShape();
		if (!shape) return;
		const styles = getComputedStyle(this.containerEl);
		const accent = styles.getPropertyValue("--interactive-accent").trim() || "#7c6ee6";

		const ctx = this.activeCtx;
		ctx.save();
		ctx.strokeStyle = accent;
		ctx.lineWidth = 1.5 / this.viewport.scale;
		ctx.setLineDash([6 / this.viewport.scale, 4 / this.viewport.scale]);
		ctx.lineDashOffset = this.marqueeDashOffset;
		ctx.beginPath();
		if (shape.mode === "rect") {
			ctx.rect(shape.bounds.minX, shape.bounds.minY, shape.bounds.maxX - shape.bounds.minX, shape.bounds.maxY - shape.bounds.minY);
		} else {
			ctx.moveTo(shape.points[0].x, shape.points[0].y);
			for (const p of shape.points.slice(1)) ctx.lineTo(p.x, p.y);
		}
		ctx.stroke();
		ctx.restore();
	}

	/**
	 * Cadre englobant, huit poignées de redimensionnement et une poignée de
	 * rotation de la sélection sur `pageIndex` — dessinés en repère écran
	 * (identité, pas la transformation de vue) pour que leur taille reste
	 * constante quel que soit le zoom, ce qu'on attend d'un contrôle
	 * d'interface plutôt que d'un élément du dessin.
	 *
	 * `transformable` à faux (sélection contenant un élément verrouillé,
	 * voir isSelectionTransformable) : le cadre reste affiché — la sélection
	 * elle-même reste valide — mais sans aucune poignée, puisqu'aucun geste de
	 * redimensionnement ou de rotation n'est possible dessus.
	 */
	private drawSelectionOverlay(pageIndex: number, bounds: StrokeBounds | null, transformable = true): void {
		if (!bounds) return;
		const styles = getComputedStyle(this.containerEl);
		const accent = styles.getPropertyValue("--interactive-accent").trim() || "#7c6ee6";
		const dpr = window.devicePixelRatio || 1;

		const [x0, y0] = this.pageToScreen(pageIndex, bounds.minX, bounds.minY);
		const [x1, y1] = this.pageToScreen(pageIndex, bounds.maxX, bounds.maxY);

		const ctx = this.activeCtx;
		ctx.save();
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		ctx.strokeStyle = accent;
		ctx.lineWidth = 1.5;
		ctx.setLineDash([]);
		ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);

		if (transformable) {
			const positions = this.selectionHandlePositions(pageIndex, bounds);
			const [rx, ry] = positions.rotate;
			ctx.beginPath();
			ctx.moveTo((x0 + x1) / 2, y0);
			ctx.lineTo(rx, ry);
			ctx.stroke();

			ctx.fillStyle = accent;
			ctx.beginPath();
			ctx.arc(rx, ry, HANDLE_SIZE_PX / 2, 0, Math.PI * 2);
			ctx.fill();

			ctx.fillStyle = "#ffffff";
			for (const handle of RESIZE_HANDLES) {
				const [hx, hy] = positions[handle];
				ctx.fillRect(hx - HANDLE_SIZE_PX / 2, hy - HANDLE_SIZE_PX / 2, HANDLE_SIZE_PX, HANDLE_SIZE_PX);
				ctx.strokeRect(hx - HANDLE_SIZE_PX / 2, hy - HANDLE_SIZE_PX / 2, HANDLE_SIZE_PX, HANDLE_SIZE_PX);
			}
		}

		ctx.restore();
	}

	/**
	 * Petit badge cadenas au coin (haut-droit) de chaque élément verrouillé
	 * des pages actuellement dans la plage visible (voir visiblePageRange) —
	 * pas seulement ceux sélectionnés : c'est ce qui permet de repérer un
	 * élément verrouillé avant même de cliquer dessus. N'est dessiné qu'à
	 * l'outil sélection (voir redrawActiveCanvas) : ailleurs, le verrouillage
	 * n'a aucun effet visible ou fonctionnel.
	 */
	private drawLockIcons(): void {
		const range = this.visiblePageRange();
		if (range.last < range.first) return;

		const dpr = window.devicePixelRatio || 1;
		const ctx = this.activeCtx;
		ctx.save();
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		for (let i = range.first; i <= range.last; i++) {
			const rt = this.pages[i];
			if (!rt) continue;
			for (const el of rt.page.elements) {
				// Une forme (voir ShapeElement, model.ts) n'a pas de champ
				// `locked` du tout — jamais verrouillable, hors de portée de
				// cette première version (voir sa doc).
				if (el.type === "shape" || !el.locked) continue;
				const bounds = computeElementBounds(el);
				const [x, y] = this.pageToScreen(i, bounds.maxX, bounds.minY);
				this.drawLockGlyph(ctx, x, y);
			}
		}
		ctx.restore();
	}

	/** Dessine un cadenas discret centré sur (x, y), en repère écran identité. */
	private drawLockGlyph(ctx: CanvasRenderingContext2D, x: number, y: number): void {
		const styles = getComputedStyle(this.containerEl);
		const bg = styles.getPropertyValue("--background-primary").trim() || "#202020";
		const fg = styles.getPropertyValue("--text-normal").trim() || "#dcdcdc";
		const border = styles.getPropertyValue("--background-modifier-border").trim() || "#444444";

		ctx.save();
		ctx.beginPath();
		ctx.arc(x, y, LOCK_BADGE_RADIUS_PX, 0, Math.PI * 2);
		ctx.fillStyle = bg;
		ctx.fill();
		ctx.lineWidth = 1;
		ctx.strokeStyle = border;
		ctx.stroke();

		ctx.strokeStyle = fg;
		ctx.lineWidth = 1.2;
		ctx.beginPath();
		ctx.arc(x, y - 1, 2.6, Math.PI, 0);
		ctx.stroke();

		ctx.fillStyle = fg;
		ctx.fillRect(x - 3, y - 1, 6, 4.5);
		ctx.restore();
	}

	/**
	 * Halo bref signalant qu'une conversion par maintien vient d'avoir lieu
	 * (jamais déclenché par Maj, geste déjà volontaire — voir triggerStraighten).
	 * S'anime indépendamment des événements pointeur : startStraightenFlash()
	 * reprogramme ses propres frames tant que la durée n'est pas écoulée, pour
	 * continuer même si l'utilisateur reste parfaitement immobile. Dessiné
	 * dans le repère déjà établi par l'appelant (voir applyPageViewTransform
	 * dans redrawActiveCanvas) : activeStroke.points est en repère de sa page.
	 */
	private drawStraightenFlash(): void {
		if (this.straightenFlashStart === null || !this.activeStroke) return;
		const elapsed = performance.now() - this.straightenFlashStart;
		const t = Math.min(1, elapsed / STRAIGHTEN_FLASH_MS);
		const [p0, p1] = this.activeStroke.points;
		const styles = getComputedStyle(this.containerEl);
		const accent = styles.getPropertyValue("--interactive-accent").trim() || "#7c6ee6";

		const ctx = this.activeCtx;
		ctx.save();
		ctx.globalAlpha = (1 - t) * 0.55;
		ctx.strokeStyle = accent;
		ctx.lineCap = "round";
		ctx.lineWidth = this.activeStroke.size + 8 + t * 6;
		ctx.beginPath();
		ctx.moveTo(p0[0], p0[1]);
		ctx.lineTo(p1[0], p1[1]);
		ctx.stroke();
		ctx.restore();
	}

	/**
	 * Étiquette d'angle près de l'extrémité libre du segment, en repère écran
	 * (jamais transformé par le zoom/panoramique — un texte à taille logique
	 * deviendrait énorme à 400% ou illisible à 25%). N'apparaît que si le
	 * segment a une direction (snapAngleDeg non nul, voir updateStraightLine) :
	 * un segment de longueur nulle n'a rien à afficher.
	 */
	private drawStraightLineHud(pageIndex: number): void {
		const sl = this.straightLine;
		if (!sl || sl.snapAngleDeg === null || !this.activeStroke) return;
		const [ex, ey] = this.activeStroke.points[1];
		const [sx, sy] = this.pageToScreen(pageIndex, ex, ey);

		const styles = getComputedStyle(this.containerEl);
		const bg = styles.getPropertyValue("--background-primary").trim() || "#202020";
		const fg = styles.getPropertyValue("--text-normal").trim() || "#dcdcdc";
		const border = styles.getPropertyValue("--background-modifier-border").trim() || "#444444";
		const label = `${Math.round(sl.snapAngleDeg)}°`;

		const ctx = this.activeCtx;
		const dpr = window.devicePixelRatio || 1;
		ctx.save();
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.font = "600 11px sans-serif";
		const textWidth = ctx.measureText(label).width;
		const paddingX = 5;
		const boxW = textWidth + paddingX * 2;
		const boxH = 16;
		const bx = sx + 10;
		const by = sy - boxH - 6;

		ctx.fillStyle = bg;
		ctx.strokeStyle = border;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.rect(bx, by, boxW, boxH);
		ctx.fill();
		ctx.stroke();

		ctx.fillStyle = fg;
		ctx.textBaseline = "middle";
		ctx.fillText(label, bx + paddingX, by + boxH / 2 + 0.5);
		ctx.restore();
	}

	// --- Zoom / panoramique -------------------------------------------------------

	/**
	 * Point d'entrée unique après tout changement de cadrage : borne
	 * l'échelle, met à jour l'affichage du pourcentage, recopie les caches sur
	 * la fenêtre visible (bon marché) et, seulement si l'échelle a
	 * suffisamment changé (pas pour un panoramique pur), planifie une
	 * régénération de toutes les pages une fois le geste stabilisé.
	 */
	private onViewportChanged(): void {
		this.viewport.scale = clamp(this.viewport.scale, MIN_SCALE, MAX_SCALE);
		this.clampViewportOffset();
		this.updateZoomLabel();
		this.scheduleViewportRedraw();
		this.scheduleActiveRedraw();

		const dpr = window.devicePixelRatio || 1;
		const neededCacheScale = Math.min(this.viewport.scale * dpr, MAX_CACHE_SCALE);
		const anyRef = this.pages[0]?.cacheScale ?? neededCacheScale;
		if (Math.abs(neededCacheScale / anyRef - 1) > CACHE_RESCALE_THRESHOLD) {
			this.scheduleCacheRegenAfterSettle();
		}
	}

	/**
	 * Empêche de faire défiler au-delà de la première ou de la dernière page —
	 * sinon un panoramique vertical (molette, glisser, pincement, zoom) peut
	 * envoyer la vue dans un vide sans fin au-dessus ou en dessous du document.
	 * Appelé depuis onViewportChanged(), donc après TOUT changement de
	 * viewport, quel qu'en soit le déclencheur. Seul l'axe vertical est
	 * borné : les pages sont un empilement du haut vers le bas (voir
	 * layoutPages), "première/dernière page" n'a de sens que sur cet axe —
	 * horizontalement, une page plus étroite que le volet doit rester
	 * librement déplaçable des deux côtés.
	 */
	private clampViewportOffset(): void {
		if (!this.wrapper || this.pages.length === 0) return;
		const rect = this.wrapper.getBoundingClientRect();
		if (rect.height <= 0) return;

		const margin = 24;
		const scale = this.viewport.scale;
		const first = this.pages[0];
		const last = this.pages[this.pages.length - 1];
		const contentTop = first.originY * scale;
		const contentBottom = (last.originY + last.page.height) * scale;

		// Le haut de la première page ne doit jamais descendre plus bas que
		// `margin` (borne haute de offsetY) ; le bas de la dernière page ne
		// doit jamais remonter plus haut que `rect.height - margin` (borne
		// basse). Voir documentToScreen : screen_y = offsetY + doc_y * scale.
		const maxOffsetY = margin - contentTop;
		const minOffsetY = rect.height - margin - contentBottom;

		this.viewport.offsetY =
			minOffsetY <= maxOffsetY
				? clamp(this.viewport.offsetY, minOffsetY, maxOffsetY)
				: // Document plus petit que le volet (peu de pages, zoom arrière) :
				  // les deux bornes se croisent, le centrer plutôt que de choisir
				  // arbitrairement laquelle respecter.
				  (minOffsetY + maxOffsetY) / 2;
	}

	/** Marque toutes les pages à régénérer une fois le geste de zoom stabilisé — leur régénération réelle reste paresseuse (voir redrawViewport, appelé juste après) : seules les pages visibles à ce moment-là sont retracées tout de suite. */
	private scheduleCacheRegenAfterSettle(): void {
		if (this.cacheRegenTimeout !== null) window.clearTimeout(this.cacheRegenTimeout);
		this.cacheRegenTimeout = window.setTimeout(() => {
			this.cacheRegenTimeout = null;
			for (const rt of this.pages) rt.cacheDirty = true;
			this.redrawViewport();
		}, ZOOM_SETTLE_MS);
	}

	/** Zoome en gardant fixe le point du document actuellement sous (sx, sy) — coordonnées écran relatives au canvas. */
	private zoomAt(sx: number, sy: number, newScale: number): void {
		const clamped = clamp(newScale, MIN_SCALE, MAX_SCALE);
		const [dx, dy] = this.screenToDocument(sx, sy);
		this.viewport.scale = clamped;
		this.viewport.offsetX = sx - dx * clamped;
		this.viewport.offsetY = sy - dy * clamped;
		this.onViewportChanged();
	}

	private zoomBy(factor: number): void {
		if (!this.wrapper) return;
		const rect = this.wrapper.getBoundingClientRect();
		this.zoomAt(rect.width / 2, rect.height / 2, this.viewport.scale * factor);
	}

	private resetZoom(): void {
		if (!this.wrapper) return;
		const rect = this.wrapper.getBoundingClientRect();
		this.zoomAt(rect.width / 2, rect.height / 2, 1);
	}

	/**
	 * Ajuste l'échelle pour que la largeur du document (la plus large des
	 * pages, voir layoutPages) tienne dans le volet visible, et remonte au
	 * sommet de la première page. Avec le défilement continu multi-page, on
	 * n'ajuste plus la hauteur pour faire tenir un cahier entier de haut en
	 * bas — ça l'écraserait à une taille illisible dès quelques pages —
	 * seule la largeur compte, comme dans une visionneuse de document.
	 *
	 * Remonter à la première page n'a de sens qu'ici, au tout premier
	 * affichage d'un document (voir setViewData/clear/onOpen, les seuls
	 * appelants) : pour le bouton et le menu contextuel « Ajuster à la
	 * fenêtre », qu'on peut rappeler n'importe quand en cours de travail,
	 * voir fitWidthToWindow() ci-dessous, qui garde la position plutôt que
	 * de toujours ramener à la page 1.
	 */
	private fitToWindow(): void {
		if (!this.wrapper || this.pages.length === 0) return;
		const rect = this.wrapper.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;

		const margin = 24;
		const scale = clamp((rect.width - margin * 2) / this.documentWidth, MIN_SCALE, FIT_MAX_SCALE);

		this.viewport.scale = scale;
		this.viewport.offsetX = (rect.width - this.documentWidth * scale) / 2;
		this.viewport.offsetY = margin - this.pages[0].originY * scale;
		this.onViewportChanged();
	}

	/**
	 * Version de fitToWindow() pour un déclenchement manuel (bouton de la
	 * barre d'outils, entrée « Ajuster à la fenêtre » du menu contextuel) :
	 * même ajustement de largeur, mais garde le point document actuellement
	 * au centre du volet plutôt que de remonter au sommet de la première
	 * page — sans quoi ce bouton ramenait systématiquement à la page 1
	 * depuis n'importe où ailleurs dans un cahier de plusieurs pages, un
	 * comportement surprenant que fitToWindow() n'avait jamais visé (lui
	 * n'est appelé qu'au tout premier affichage, où revenir en haut de la
	 * page 1 EST le comportement voulu). Même technique que zoomAt() : un
	 * point du document fixé à l'écran de part et d'autre du changement
	 * d'échelle, ici le centre du volet plutôt qu'un point sous le curseur.
	 */
	private fitWidthToWindow(): void {
		if (!this.wrapper || this.pages.length === 0) return;
		const rect = this.wrapper.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;

		const [, centerDocY] = this.screenToDocument(rect.width / 2, rect.height / 2);

		const margin = 24;
		const scale = clamp((rect.width - margin * 2) / this.documentWidth, MIN_SCALE, FIT_MAX_SCALE);

		this.viewport.scale = scale;
		this.viewport.offsetX = (rect.width - this.documentWidth * scale) / 2;
		this.viewport.offsetY = rect.height / 2 - centerDocY * scale;
		this.onViewportChanged();
	}

	/** Fait défiler jusqu'à `pageIndex` (son sommet juste sous la marge) sans changer l'échelle — utilisé après insertPageAt(). */
	private scrollToPage(pageIndex: number): void {
		if (!this.wrapper) return;
		const rt = this.pages[pageIndex];
		if (!rt) return;
		const margin = 24;
		this.viewport.offsetY = margin - rt.originY * this.viewport.scale;
		this.onViewportChanged();
	}

	private updateZoomLabel(): void {
		if (!this.zoomLabelEl) return;
		this.zoomLabelEl.setText(`${Math.round(this.viewport.scale * 100)} %`);
	}

	/** Même page de référence que pageBtn (voir buildToolbar) : celle visible au centre du volet, pas focusedPageIndex — appelé depuis redrawViewport(), qui couvre aussi bien un panoramique/zoom qu'un ajout/suppression/déplacement de page. */
	private updatePageIndicator(): void {
		if (!this.pageIndicatorEl) return;
		const current = (this.centerVisiblePageIndex() ?? this.focusedPageIndex) + 1;
		this.pageIndicatorEl.setText(`Page ${current} / ${this.pages.length}`);
	}

	/** Ouvre GoToPageModal pour taper directement un numéro de page — voir pageIndicatorEl. */
	private promptGoToPage(): void {
		const total = this.pages.length;
		const current = (this.centerVisiblePageIndex() ?? this.focusedPageIndex) + 1;
		new GoToPageModal(this.app, current, total, (target) => this.scrollToPage(target - 1)).open();
	}

	private updateCursor(): void {
		if (!this.committedCanvas) return;
		const panning = this.viewportGesture !== null;
		this.committedCanvas.toggleClass("is-panning", panning);
		this.committedCanvas.toggleClass(
			"is-pan-ready",
			!panning && (this.spacePressed || this.plugin.settings.tool === "hand")
		);
	}

	private onWheel = (event: WheelEvent): void => {
		if (!this.committedCanvas) return;
		event.preventDefault();

		if (event.ctrlKey) {
			// Ctrl+molette — aussi ce que le navigateur rapporte pour un
			// pincement de pavé tactile — zoome en gardant le point sous le
			// curseur fixe. Rect toujours celui du canevas, même si l'événement
			// est arrivé ailleurs dans la vue (voir onOpen, écouteur posé sur
			// contentEl) : sx/sy restent le bon point d'ancrage, dans le repère
			// écran du canevas, même hors de ses limites visibles.
			const rect = this.committedCanvas.getBoundingClientRect();
			const sx = event.clientX - rect.left;
			const sy = event.clientY - rect.top;
			const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_SPEED);
			this.zoomAt(sx, sy, this.viewport.scale * factor);
			return;
		}

		// Molette seule (verticale ou horizontale — un pavé tactile à deux
		// doigts, ou Maj+molette, rapportent directement deltaX) : panoramique,
		// comme n'importe quel document. deltaX/deltaY sont déjà en pixels
		// écran, donc directement soustractibles du décalage courant (voir
		// Viewport) sans tenir compte de l'échelle.
		this.viewport.offsetX -= event.deltaX;
		this.viewport.offsetY -= event.deltaY;
		this.onViewportChanged();
	};

	private onWindowKeyDown = (event: KeyboardEvent): void => {
		if (event.code !== "Space" || event.repeat) return;
		if (this.app.workspace.getActiveViewOfType(DrawView) !== this) return;
		event.preventDefault();
		this.spacePressed = true;
		this.updateCursor();
	};

	private onWindowKeyUp = (event: KeyboardEvent): void => {
		if (event.code !== "Space") return;
		this.spacePressed = false;
		this.updateCursor();
	};

	private isPanTrigger(event: PointerEvent): boolean {
		if (event.button === 1) return true; // clic milieu maintenu
		if (this.spacePressed && event.button === 0) return true; // barre d'espace maintenue + clic gauche
		if (this.plugin.settings.tool === "hand" && event.button === 0) return true; // outil main actif + clic gauche
		return false;
	}

	private countActiveTouches(): number {
		let count = 0;
		for (const [id, e] of this.pointers) {
			if (e.pointerType === "touch" && !this.ignoredPointerIds.has(id)) count++;
		}
		return count;
	}

	/** Annule le trait ou la gomme en cours (au profit d'un pincement qui démarre, ou d'un appui long qui ouvre le menu contextuel — voir triggerLongPressMenu), sans rien enregistrer. */
	private cancelActiveDrawOrErase(): void {
		if (this.eraseZoneSession) {
			this.finishEraseZone();
		} else if (this.eraseStrokeSession) {
			this.finishEraseStroke();
		} else if (this.transformSession) {
			this.cancelTransform();
		} else if (this.activeMarquee) {
			this.activeMarquee = null;
			this.scheduleActiveRedraw();
		} else if (this.activeShape) {
			this.activeShape = null;
			this.activeShapePageIndex = null;
			this.activeShapeStart = null;
			this.clearActiveCanvasFull();
		} else if (this.activeStroke) {
			this.activeStroke = null;
			this.activeStrokePageIndex = null;
			this.resetStraightLineState();
			this.clearActiveCanvasFull();
		}
		this.activePointerId = null;
	}

	// --- Menu contextuel : clic droit ou appui long tactile ----------------------

	/** (Ré)arme le minuteur d'appui long à une position écran donnée : tout appel ultérieur avant son expiration l'annule et le redémarre (voir updateLongPressMenu). */
	private armLongPressMenu(clientX: number, clientY: number): void {
		this.clearLongPressMenu();
		this.longPressMenuStart = { clientX, clientY };
		this.longPressMenuTimer = window.setTimeout(() => {
			this.longPressMenuTimer = null;
			this.triggerLongPressMenu();
		}, LONG_PRESS_MENU_MS);
	}

	private clearLongPressMenu(): void {
		if (this.longPressMenuTimer !== null) {
			window.clearTimeout(this.longPressMenuTimer);
			this.longPressMenuTimer = null;
		}
		this.longPressMenuStart = null;
	}

	/** Annule l'appui long dès que le doigt s'éloigne trop de son point de départ : un déplacement, c'est un tracé ou un panoramique voulu, pas une demande de menu. */
	private updateLongPressMenu(clientX: number, clientY: number): void {
		if (!this.longPressMenuStart) return;
		const dist = Math.hypot(clientX - this.longPressMenuStart.clientX, clientY - this.longPressMenuStart.clientY);
		if (dist > LONG_PRESS_MENU_MOVE_THRESHOLD_PX) this.clearLongPressMenu();
	}

	/**
	 * L'appui est resté immobile assez longtemps : interrompt le trait ou la
	 * gomme en cours sans l'enregistrer (comme un pincement qui démarre — voir
	 * cancelActiveDrawOrErase) et ouvre le menu contextuel à la place. Un appui
	 * long est une demande de menu, jamais une marque sur la feuille.
	 */
	private triggerLongPressMenu(): void {
		const anchor = this.longPressMenuStart;
		this.longPressMenuStart = null;
		if (!anchor) return;

		this.cancelActiveDrawOrErase();
		if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
			navigator.vibrate(20);
		}
		this.openContextMenu(anchor.clientX, anchor.clientY);
	}

	private onContextMenu = (event: MouseEvent): void => {
		event.preventDefault();
		this.openContextMenu(event.clientX, event.clientY);
	};

	/**
	 * Coller, insérer une image, changer le fond, ajuster à la fenêtre,
	 * réinitialiser le zoom, supprimer la page : les actions qu'on veut sans
	 * devoir viser un bouton précis de la barre d'outils, accessibles où que
	 * le clic droit ou l'appui long ait eu lieu sur la feuille. `x`/`y` sont
	 * des coordonnées client (celles d'un MouseEvent, ou du point d'appui
	 * long — voir triggerLongPressMenu).
	 */
	private openContextMenu(x: number, y: number): void {
		if (isSelectionTool(this.plugin.settings.tool) && this.selectedIds.size > 0 && this.isPointOnSelection(x, y)) {
			this.openSelectionContextMenu(x, y);
			return;
		}

		const rect = this.committedCanvas.getBoundingClientRect();
		const [docX, docY] = this.screenToDocument(x - rect.left, y - rect.top);
		const clickedPage = this.hitPage(docX, docY);
		const pageIndex = clickedPage ?? this.focusedPageIndex;

		const menu = new Menu();

		menu.addItem((item) =>
			item
				.setTitle("Paste")
				.setIcon("clipboard-paste")
				.onClick(() => void this.pasteFromClipboard())
		);
		menu.addItem((item) =>
			item
				.setTitle("Insert an image")
				.setIcon("image")
				.onClick(() => this.openImagePicker())
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Change background")
				.setIcon("layout-grid")
				.onClick(() => this.openPageMenu(x, y, pageIndex))
		);
		menu.addItem((item) =>
			item
				.setTitle("Fit to window")
				.setIcon("maximize")
				.onClick(() => this.fitWidthToWindow())
		);
		menu.addItem((item) =>
			item
				.setTitle("Reset zoom")
				.setIcon("zoom-in")
				.onClick(() => this.resetZoom())
		);

		if (this.pages.length > 1 && clickedPage !== null) {
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("Delete this page")
					.setIcon("trash-2")
					.onClick(() => this.requestDeletePage(clickedPage))
			);
		}

		menu.showAtPosition({ x, y });
	}

	private isPointOnSelection(clientX: number, clientY: number): boolean {
		const rect = this.committedCanvas.getBoundingClientRect();
		const [docX, docY] = this.screenToDocument(clientX - rect.left, clientY - rect.top);
		const pageIndex = this.hitPage(docX, docY);
		if (pageIndex === null || pageIndex !== this.selectedPageIndex) return false;
		const [x, y] = this.toPageLocal(pageIndex, docX, docY);
		const bounds = this.selectionBounds();
		if (bounds && pointInRect(x, y, bounds)) return true;
		const hit = this.hitTestElementAt(pageIndex, x, y);
		return hit !== null && this.selectedIds.has(hit.id);
	}

	/** Regroupe les opérations de la sélection (voir "Opérations" dans la fonctionnalité) : copier/couper/coller/dupliquer/supprimer, couleur/épaisseur des traits ET formes sélectionnés (une image n'a ni couleur ni épaisseur de contour), premier/arrière-plan. */
	private openSelectionContextMenu(x: number, y: number): void {
		const menu = new Menu();
		const page = this.selectedPageIndex !== null ? this.pages[this.selectedPageIndex].page : null;
		const hasColorable = page
			? page.elements.some((el) => this.selectedIds.has(el.id) && (el.type === "stroke" || el.type === "shape"))
			: false;

		menu.addItem((item) =>
			item.setTitle("Copy").setIcon("copy").onClick(() => this.copySelectionToClipboard())
		);
		menu.addItem((item) => item.setTitle("Cut").setIcon("scissors").onClick(() => this.cutSelection()));
		menu.addItem((item) =>
			item.setTitle("Paste").setIcon("clipboard-paste").onClick(() => void this.pasteFromClipboard())
		);
		menu.addItem((item) =>
			item.setTitle("Duplicate").setIcon("copy-plus").onClick(() => this.duplicateSelection())
		);
		menu.addItem((item) =>
			item.setTitle("Delete").setIcon("trash-2").onClick(() => this.deleteSelection())
		);

		if (hasColorable) {
			menu.addSeparator();
			menu.addItem((item) =>
				item.setTitle("Color…").setIcon("palette").onClick(() => this.openSelectionColorPicker(x, y))
			);
			menu.addItem((item) =>
				item.setTitle("Thickness…").setIcon("pen-line").onClick(() => this.openSelectionThicknessMenu(x, y))
			);
		}

		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle("Bring to front").setIcon("bring-to-front").onClick(() => this.bringSelectionToFront())
		);
		menu.addItem((item) =>
			item.setTitle("Send to back").setIcon("send-to-back").onClick(() => this.sendSelectionToBack())
		);

		menu.showAtPosition({ x, y });
	}

	/** Couleur du premier trait OU forme de la sélection (jamais une image, qui n'en a pas) — sert d'aperçu initial au sélecteur de couleur ouvert depuis le menu contextuel. */
	private firstSelectedStrokeColor(): string | null {
		if (this.selectedPageIndex === null) return null;
		for (const el of this.pages[this.selectedPageIndex].page.elements) {
			if (this.selectedIds.has(el.id) && (el.type === "stroke" || el.type === "shape")) return el.color;
		}
		return null;
	}

	/** Ancre invisible positionnée au point de clic : openColorPicker a besoin d'un HTMLElement à ancrer, qu'un clic de menu contextuel ne fournit pas naturellement. */
	private openSelectionColorPicker(x: number, y: number): void {
		const anchor = document.createElement("div");
		anchor.setCssStyles({
			position: "fixed",
			left: `${x}px`,
			top: `${y}px`,
			width: "0",
			height: "0",
		});
		document.body.appendChild(anchor);

		openColorPicker({
			anchor,
			initialColor: this.firstSelectedStrokeColor() ?? this.activeColor,
			onCommit: (color) => {
				this.recolorSelection(color);
				anchor.remove();
			},
			onCancel: () => anchor.remove(),
		});
	}

	private openSelectionThicknessMenu(x: number, y: number): void {
		const menu = new Menu();
		for (const size of SIZES) {
			menu.addItem((item) =>
				item.setTitle(`Thickness ${size}`).onClick(() => this.resizeSelectionThickness(size))
			);
		}
		menu.showAtPosition({ x, y });
	}

	private startPanGesture(event: PointerEvent): void {
		this.viewportGesture = {
			type: "pan",
			pointerId: event.pointerId,
			startClientX: event.clientX,
			startClientY: event.clientY,
			startOffsetX: this.viewport.offsetX,
			startOffsetY: this.viewport.offsetY,
		};
		this.updateCursor();
	}

	/** Pincement à deux doigts : zoome ET déplace simultanément, en gardant le point milieu du document sous le milieu des deux doigts — donc gère aussi un simple glissement à deux doigts (distance inchangée = pur panoramique). */
	private startPinchGesture(): void {
		this.cancelActiveDrawOrErase();

		const touchIds = [...this.pointers.entries()]
			.filter(([id, e]) => e.pointerType === "touch" && !this.ignoredPointerIds.has(id))
			.map(([id]) => id);
		if (touchIds.length < 2) return;
		const [idA, idB] = touchIds;
		const a = this.pointers.get(idA);
		const b = this.pointers.get(idB);
		if (!a || !b || !this.committedCanvas) return;

		const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) || 1;
		const midClientX = (a.clientX + b.clientX) / 2;
		const midClientY = (a.clientY + b.clientY) / 2;
		const rect = this.committedCanvas.getBoundingClientRect();
		const startMidDocument = this.screenToDocument(midClientX - rect.left, midClientY - rect.top);

		this.viewportGesture = {
			type: "pinch",
			pointerIds: [idA, idB],
			startDistance: dist,
			startScale: this.viewport.scale,
			startMidDocument,
		};
		this.updateCursor();
	}

	private updateViewportGesture(event: PointerEvent): void {
		const gesture = this.viewportGesture;
		if (!gesture || !this.committedCanvas) return;

		if (gesture.type === "pan") {
			if (event.pointerId !== gesture.pointerId) return;
			this.viewport.offsetX = gesture.startOffsetX + (event.clientX - gesture.startClientX);
			this.viewport.offsetY = gesture.startOffsetY + (event.clientY - gesture.startClientY);
			this.onViewportChanged();
			return;
		}

		const [idA, idB] = gesture.pointerIds;
		if (event.pointerId !== idA && event.pointerId !== idB) return;
		const a = this.pointers.get(idA);
		const b = this.pointers.get(idB);
		if (!a || !b) return;

		const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) || 1;
		const midClientX = (a.clientX + b.clientX) / 2;
		const midClientY = (a.clientY + b.clientY) / 2;
		const rect = this.committedCanvas.getBoundingClientRect();

		const newScale = clamp(gesture.startScale * (dist / gesture.startDistance), MIN_SCALE, MAX_SCALE);
		this.viewport.scale = newScale;
		this.viewport.offsetX = midClientX - rect.left - gesture.startMidDocument[0] * newScale;
		this.viewport.offsetY = midClientY - rect.top - gesture.startMidDocument[1] * newScale;
		this.onViewportChanged();
	}

	private maybeEndViewportGesture(pointerId: number): void {
		const gesture = this.viewportGesture;
		if (!gesture) return;
		const involved =
			gesture.type === "pan" ? gesture.pointerId === pointerId : gesture.pointerIds.includes(pointerId);
		if (!involved) return;
		this.viewportGesture = null;
		this.updateCursor();
		this.scheduleCacheRegenAfterSettle();
	}

	// --- Barre d'outils ---------------------------------------------------------

	private buildToolbar(): void {
		this.toolbarEl = this.contentEl.createDiv({ cls: "quillstone-toolbar" });

		const tools = this.toolbarEl.createDiv({ cls: "quillstone-toolbar-group" });
		for (const tool of TOOLS) {
			const btn = tools.createDiv({ cls: "clickable-icon" });
			setIcon(btn, TOOL_ICONS[tool]);
			btn.setAttribute("aria-label", TOOL_LABELS[tool]);
			btn.addEventListener("click", () => this.setTool(tool));
			this.toolButtons.set(tool, btn);
		}

		// Palette de formes prédéfinies : juste à côté du lasso, dans le même
		// groupe que les autres outils — UN SEUL bouton (pas quatre icônes
		// fixes) qui ouvre un menu listant les quatre (voir openShapeMenu).
		// Son icône suit la forme actuellement active (voir syncToolbarState),
		// ou reste une icône générique "formes" tant qu'aucune n'est active.
		this.shapesMenuBtn = tools.createDiv({ cls: "clickable-icon" });
		this.shapesMenuBtn.addEventListener("click", (evt) => this.openShapeMenu(evt.clientX, evt.clientY));

		// Pointeur laser : en tout dernier de ce groupe — il ne dessine rien de
		// persistant (voir laserPoints) et n'a pas de couleur personnalisable,
		// contrairement à tout ce qui le précède ici.
		const laserBtn = tools.createDiv({ cls: "clickable-icon" });
		setIcon(laserBtn, TOOL_ICONS.laser);
		laserBtn.setAttribute("aria-label", TOOL_LABELS.laser);
		setTooltip(laserBtn, TOOL_LABELS.laser);
		laserBtn.addEventListener("click", () => this.setTool("laser"));
		this.toolButtons.set("laser", laserBtn);

		this.colorsGroupEl = this.toolbarEl.createDiv({ cls: "quillstone-toolbar-group" });

		const sizes = this.toolbarEl.createDiv({ cls: "quillstone-toolbar-group" });
		for (const size of SIZES) {
			const btn = sizes.createDiv({ cls: "quillstone-size" });
			const dot = btn.createDiv({ cls: "quillstone-size-dot" });
			const dotSize = 4 + size;
			dot.setCssStyles({ width: `${dotSize}px`, height: `${dotSize}px` });
			btn.setAttribute("aria-label", `Thickness ${size}`);
			btn.addEventListener("click", () => this.setSize(size));
			this.sizeButtons.set(size, btn);
		}

		const history = this.toolbarEl.createDiv({ cls: "quillstone-toolbar-group" });
		this.undoBtn = history.createDiv({ cls: "clickable-icon" });
		setIcon(this.undoBtn, "undo-2");
		this.undoBtn.setAttribute("aria-label", "Undo");
		this.undoBtn.addEventListener("click", () => this.undo());

		this.redoBtn = history.createDiv({ cls: "clickable-icon" });
		setIcon(this.redoBtn, "redo-2");
		this.redoBtn.setAttribute("aria-label", "Redo");
		this.redoBtn.addEventListener("click", () => this.redo());

		// Dupliquer, premier/arrière-plan, verrou et suppression : équivalents
		// en boutons des mêmes actions déjà présentes dans le menu contextuel
		// de la sélection (voir openSelectionContextMenu) — masqué tant
		// qu'aucune sélection n'existe (voir updateSelectionActionsToolbar),
		// pas seulement grisé comme le groupe couleurs, puisqu'il n'a aucun
		// sens hors sélection. Fonctionne aussi bien pour une sélection au
		// lasso qu'un clic simple : duplicateSelection() ne distingue pas.
		this.selectionActionsGroupEl = this.toolbarEl.createDiv({ cls: "quillstone-toolbar-group" });
		const duplicateBtn = this.selectionActionsGroupEl.createDiv({ cls: "clickable-icon" });
		setIcon(duplicateBtn, "copy-plus");
		duplicateBtn.setAttribute("aria-label", "Duplicate");
		setTooltip(duplicateBtn, "Duplicate");
		duplicateBtn.addEventListener("click", () => this.duplicateSelection());

		const bringFrontBtn = this.selectionActionsGroupEl.createDiv({ cls: "clickable-icon" });
		setIcon(bringFrontBtn, "bring-to-front");
		bringFrontBtn.setAttribute("aria-label", "Bring to front");
		setTooltip(bringFrontBtn, "Bring to front");
		bringFrontBtn.addEventListener("click", () => this.bringSelectionToFront());

		const sendBackBtn = this.selectionActionsGroupEl.createDiv({ cls: "clickable-icon" });
		setIcon(sendBackBtn, "send-to-back");
		sendBackBtn.setAttribute("aria-label", "Send to back");
		setTooltip(sendBackBtn, "Send to back");
		sendBackBtn.addEventListener("click", () => this.sendSelectionToBack());

		// Une seule image sélectionnée seulement (voir updateSelectionActionsToolbar) : rogner plusieurs images à la fois n'a pas de sens.
		this.cropBtn = this.selectionActionsGroupEl.createDiv({ cls: "clickable-icon" });
		setIcon(this.cropBtn, "crop");
		this.cropBtn.setAttribute("aria-label", "Crop image");
		setTooltip(this.cropBtn, "Crop image");
		this.cropBtn.addEventListener("click", () => void this.openCropDialog());

		this.lockBtn = this.selectionActionsGroupEl.createDiv({ cls: "clickable-icon" });
		this.lockBtn.addEventListener("click", () => this.toggleSelectionLock());

		// Même fonction que la touche Suppr/Retour arrière et l'entrée
		// "Supprimer" du menu contextuel (voir deleteSelection) : agit sur
		// selectedIds sans distinction de type, trait ou image comprise.
		const deleteBtn = this.selectionActionsGroupEl.createDiv({ cls: "clickable-icon" });
		setIcon(deleteBtn, "trash-2");
		deleteBtn.setAttribute("aria-label", "Delete");
		setTooltip(deleteBtn, "Delete");
		deleteBtn.addEventListener("click", () => this.deleteSelection());

		const page = this.toolbarEl.createDiv({ cls: "quillstone-toolbar-group" });
		const pageBtn = page.createDiv({ cls: "clickable-icon" });
		setIcon(pageBtn, "layout-grid");
		pageBtn.setAttribute("aria-label", "Background, density, format, orientation");
		// La page ciblée est celle actuellement visible au centre du volet
		// (voir centerVisiblePageIndex), pas focusedPageIndex : ce bouton n'a
		// pas de position de clic sur la feuille pour se repérer, et
		// focusedPageIndex ne bouge qu'au clic/tracé — resté sur une page
		// qu'on a quittée depuis en faisant défiler, il changerait
		// silencieusement l'orientation d'une page hors champ plutôt que de
		// celle sous les yeux (voir le bug signalé : "le mode paysage ne
		// fonctionne pas page par page").
		pageBtn.addEventListener("click", (evt) =>
			this.openPageMenu(evt.clientX, evt.clientY, this.centerVisiblePageIndex() ?? this.focusedPageIndex)
		);

		// Importe un PDF directement dans CETTE feuille (voir
		// importPdfIntoDocument) : ses pages s'ajoutent à la suite du document
		// déjà ouvert, sans en créer un nouveau — contrairement à la commande
		// « Importer un PDF en feuille de dessin » de main.ts, qui n'a de sens
		// que hors d'une feuille déjà ouverte (palette de commandes, note).
		const importPdfBtn = page.createDiv({ cls: "clickable-icon" });
		setIcon(importPdfBtn, "file-input");
		importPdfBtn.setAttribute("aria-label", "Import a PDF");
		setTooltip(importPdfBtn, "Import a PDF");
		importPdfBtn.addEventListener("click", () => void this.importPdfIntoDocument());

		// Juste à côté de l'import : exporte TOUT le document (voir
		// exportToPdf), pas seulement la page courante — un PDF par feuille,
		// symétrique de l'import.
		const exportPdfBtn = page.createDiv({ cls: "clickable-icon" });
		setIcon(exportPdfBtn, "file-output");
		exportPdfBtn.setAttribute("aria-label", "Export to PDF");
		setTooltip(exportPdfBtn, "Export to PDF");
		exportPdfBtn.addEventListener("click", () => void this.exportToPdf());

		const zoom = this.toolbarEl.createDiv({ cls: "quillstone-toolbar-group" });
		const zoomOutBtn = zoom.createDiv({ cls: "clickable-icon" });
		setIcon(zoomOutBtn, "zoom-out");
		zoomOutBtn.setAttribute("aria-label", "Zoom out");
		zoomOutBtn.addEventListener("click", () => this.zoomBy(1 / ZOOM_STEP));

		const zoomResetBtn = zoom.createDiv({ cls: "quillstone-zoom-reset" });
		zoomResetBtn.setText("100 %");
		zoomResetBtn.setAttribute("aria-label", "Reset to 100%");
		zoomResetBtn.addEventListener("click", () => this.resetZoom());

		const zoomInBtn = zoom.createDiv({ cls: "clickable-icon" });
		setIcon(zoomInBtn, "zoom-in");
		zoomInBtn.setAttribute("aria-label", "Zoom in");
		zoomInBtn.addEventListener("click", () => this.zoomBy(ZOOM_STEP));

		const fitBtn = zoom.createDiv({ cls: "clickable-icon" });
		setIcon(fitBtn, "maximize");
		fitBtn.setAttribute("aria-label", "Fit to window");
		fitBtn.addEventListener("click", () => this.fitWidthToWindow());

		this.zoomLabelEl = zoom.createDiv({ cls: "quillstone-zoom-label" });

		// Tout à droite de la barre (voir quillstone-page-indicator-group,
		// styles.css : margin-left: auto) — même page de référence que pageBtn
		// ci-dessus (celle visible au centre du volet), cliquable pour taper
		// directement un numéro plutôt que de faire défiler à l'aveugle (voir
		// promptGoToPage).
		const pageIndicatorGroup = this.toolbarEl.createDiv({
			cls: "quillstone-toolbar-group quillstone-page-indicator-group",
		});
		this.pageIndicatorEl = pageIndicatorGroup.createDiv({ cls: "quillstone-page-indicator" });
		this.pageIndicatorEl.setAttribute("role", "button");
		setTooltip(this.pageIndicatorEl, "Go to page…");
		this.pageIndicatorEl.addEventListener("click", () => this.promptGoToPage());

		this.syncToolbarState();
		this.updateHistoryButtons();
		this.updateZoomLabel();
		this.updatePageIndicator();
		this.updateSelectionActionsToolbar();
	}

	/** Menu listant les quatre formes prédéfinies (voir SHAPE_TOOLS), une coche sur celle actuellement active — ouvert depuis l'unique bouton "Formes" de la barre d'outils (voir shapesMenuBtn), plutôt que quatre icônes toujours affichées. */
	private openShapeMenu(x: number, y: number): void {
		const menu = new Menu();
		for (const shape of SHAPE_TOOLS) {
			menu.addItem((item) =>
				item
					.setTitle(TOOL_LABELS[shape])
					.setIcon(TOOL_ICONS[shape])
					.setChecked(this.plugin.settings.tool === shape)
					.onClick(() => this.setTool(shape))
			);
		}
		menu.showAtPosition({ x, y });
	}

	/**
	 * Fond, densité, format et orientation sont des propriétés de la page
	 * (pas des réglages du plugin), donc regroupées dans un seul menu plutôt
	 * que dans la barre elle-même — contrairement à l'outil/couleur/
	 * épaisseur, ce ne sont pas des choix qu'on change trait par trait.
	 * `pageIndex` : la page concernée — celle sous le clic droit qui a
	 * ouvert ce menu (voir openContextMenu), ou la page actuellement visible
	 * au centre du volet si ouvert depuis le bouton de la barre d'outils
	 * (voir centerVisiblePageIndex).
	 */
	private openPageMenu(x: number, y: number, pageIndex: number): void {
		const rt = this.pages[pageIndex];
		if (!rt) return;
		const menu = new Menu();

		for (const kind of BACKGROUND_KINDS) {
			menu.addItem((item) =>
				item
					.setTitle(BACKGROUND_LABELS[kind])
					.setChecked(rt.page.background === kind)
					.onClick(() => this.setBackground(pageIndex, kind))
			);
		}

		menu.addSeparator();
		for (const density of DENSITIES) {
			menu.addItem((item) =>
				item
					.setTitle(`Density: ${DENSITY_LABELS[density]}`)
					.setChecked(rt.page.density === density)
					.onClick(() => this.setDensity(pageIndex, density))
			);
		}

		menu.addSeparator();
		const activeFormat = matchPaperFormat(rt.page);
		for (const format of PAPER_FORMATS) {
			menu.addItem((item) =>
				item
					.setTitle(`Format: ${PAPER_FORMAT_LABELS[format]}`)
					.setChecked(activeFormat === format)
					.onClick(() => this.setFormat(pageIndex, format))
			);
		}

		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Portrait")
				.setChecked(rt.page.orientation === "portrait")
				.onClick(() => this.setOrientation(pageIndex, "portrait"))
		);
		menu.addItem((item) =>
			item
				.setTitle("Landscape")
				.setChecked(rt.page.orientation === "landscape")
				.onClick(() => this.setOrientation(pageIndex, "landscape"))
		);

		menu.showAtPosition({ x, y });
	}

	/**
	 * Reconstruit entièrement le groupe couleurs pour l'outil actif : la
	 * palette principale (personnalisable, voir buildSwatch), puis — s'il y en
	 * a — une seconde rangée des couleurs récemment choisies (voir
	 * pushRecentColor), et enfin, nettement séparé de ces deux rangées, le
	 * bouton ouvrant le sélecteur maison (voir colorPicker.ts — jamais
	 * `<input type="color">`, dont la boîte de dialogue système d'Electron
	 * valide dès le premier clic). N'est appelée que quand l'outil change
	 * réellement ou que les récents changent (voir syncToolbarState,
	 * setActiveColor) : un simple changement de couleur active se contente de
	 * syncColorActiveStates(), bien moins coûteux.
	 */
	private renderColorPicker(): void {
		this.colorsGroupEl.empty();
		this.paletteSwatchEls = [];
		this.recentSwatchEls = [];
		this.freePickerButtonEl = null;

		const tool = this.activeColorTool;
		this.colorsGroupTool = tool;
		const entry = this.plugin.settings.colors[tool];

		// Bloc palette+récents à gauche, sélecteur libre nettement séparé à
		// droite (bordure + espace, voir styles.css) : les deux zones ne
		// doivent jamais se lire comme une seule rangée continue de pastilles.
		const layout = this.colorsGroupEl.createDiv({ cls: "quillstone-colors-layout" });
		const column = layout.createDiv({ cls: "quillstone-colors-column" });
		const mainRow = column.createDiv({ cls: "quillstone-color-row" });

		// Les deux rangées (base et récents) sont des grilles au même nombre de
		// colonnes, de la largeur d'une pastille de base (voir SWATCH_COL_PX,
		// à tenir en phase avec .quillstone-swatch dans styles.css) : sans ça,
		// une rangée de récents plus courte (ou aux pastilles plus petites) ne
		// tombe pas sous les mêmes colonnes que la palette au-dessus, et
		// l'ensemble a l'air désaligné plutôt que de former un bloc net.
		const columns = Math.max(entry.palette.length, entry.recent.length, 1);
		const gridTemplateColumns = `repeat(${columns}, ${SWATCH_COL_PX}px)`;
		mainRow.setCssStyles({ gridTemplateColumns });

		entry.palette.forEach((color, index) => {
			this.paletteSwatchEls.push(this.buildSwatch(mainRow, color, tool, false, index));
		});

		// La couleur active reste toujours visible dans les deux groupes,
		// palette comme récents — jamais retirée de l'un et pas de l'autre,
		// ce qui ferait varier le nombre de pastilles affichées selon que
		// l'active vient de la palette ou des récents. Elle est simplement
		// surlignée (.is-active) partout où elle apparaît, y compris en
		// double avec le bouton du sélecteur libre : ce doublon visuel est
		// voulu (voir syncColorActiveStates).
		if (entry.recent.length > 0) {
			const recentRow = column.createDiv({ cls: "quillstone-color-row quillstone-color-row-recent" });
			recentRow.setCssStyles({ gridTemplateColumns });
			for (const color of entry.recent) {
				this.recentSwatchEls.push(this.buildSwatch(recentRow, color, tool, true));
			}
		}

		const pickerWrap = layout.createDiv({ cls: "quillstone-color-picker-wrap" });
		const freePickerBtn = pickerWrap.createDiv({ cls: "quillstone-swatch quillstone-swatch-picker" });
		freePickerBtn.empty(); // pas d'icône : le bouton EST la pastille, seule sa couleur de fond le représente
		freePickerBtn.setCssStyles({ backgroundColor: entry.active });
		freePickerBtn.tabIndex = 0;
		freePickerBtn.setAttribute("role", "button");
		freePickerBtn.setAttribute("aria-label", "Custom color");
		setTooltip(freePickerBtn, "Custom color");
		this.freePickerButtonEl = freePickerBtn;

		const openFreePicker = (): void => {
			const previousColor = entry.active;
			openColorPicker({
				anchor: freePickerBtn,
				initialColor: entry.active,
				onPreview: (color) => this.previewColorLive(tool, color),
				onCommit: (color) => this.setActiveColor(tool, color, true),
				onCancel: () => this.previewColorLive(tool, previousColor),
			});
		};
		freePickerBtn.addEventListener("click", openFreePicker);
		freePickerBtn.addEventListener("keydown", (evt) => {
			if (evt.key !== "Enter" && evt.key !== " ") return;
			evt.preventDefault();
			openFreePicker();
		});

		this.syncColorActiveStates();
	}

	/**
	 * Une pastille de palette ou de récents. Clic simple : sélectionne la
	 * couleur. Pour une pastille de palette (pas les récents) : clic droit ou
	 * appui maintenu (LONG_PRESS_MS) ouvre le sélecteur maison et remplace
	 * cette teinte DÉFINITIVEMENT dans la palette (voir replacePaletteSwatch)
	 * — geste volontaire distinct du clic simple, donc pas de confirmation
	 * nécessaire.
	 */
	private buildSwatch(
		container: HTMLElement,
		color: string,
		tool: ColorableTool,
		isRecent: boolean,
		index?: number
	): HTMLElement {
		const swatch = container.createDiv({
			cls: isRecent ? "quillstone-swatch quillstone-swatch-recent" : "quillstone-swatch",
		});
		swatch.setCssStyles({ backgroundColor: color });
		swatch.dataset.color = color;
		swatch.tabIndex = 0;
		swatch.setAttribute("role", "button");
		swatch.setAttribute("aria-label", color);
		setTooltip(swatch, color);

		let longPressFired = false;
		const select = (): void => {
			if (longPressFired) {
				longPressFired = false; // le clic qui suit l'appui long ne doit pas aussi sélectionner la couleur
				return;
			}
			this.setActiveColor(tool, color, false);
		};
		swatch.addEventListener("click", select);
		swatch.addEventListener("keydown", (evt) => {
			if (evt.key !== "Enter" && evt.key !== " ") return;
			evt.preventDefault();
			select();
		});

		if (!isRecent && index !== undefined) {
			swatch.addEventListener("contextmenu", (evt) => {
				evt.preventDefault();
				this.replacePaletteSwatch(tool, index, swatch);
			});

			let longPressTimer: number | null = null;
			const clearLongPressTimer = (): void => {
				if (longPressTimer !== null) {
					window.clearTimeout(longPressTimer);
					longPressTimer = null;
				}
			};
			swatch.addEventListener("pointerdown", (evt) => {
				if (evt.button !== 0) return;
				longPressFired = false;
				clearLongPressTimer();
				longPressTimer = window.setTimeout(() => {
					longPressTimer = null;
					longPressFired = true;
					this.replacePaletteSwatch(tool, index, swatch);
				}, LONG_PRESS_MS);
			});
			swatch.addEventListener("pointerup", clearLongPressTimer);
			swatch.addEventListener("pointerleave", clearLongPressTimer);
			swatch.addEventListener("pointercancel", clearLongPressTimer);
		}

		return swatch;
	}

	/**
	 * Ouvre le sélecteur maison et remplace définitivement la couleur à
	 * `index` dans la palette de `tool` (voir QuillStoneSettings.colors) —
	 * le même composant que la page de réglages. L'aperçu en direct pendant
	 * le glissement s'applique à la couleur ACTIVE de l'outil (pas
	 * uniquement à cette pastille) : c'est elle qui pilote le rendu sur la
	 * feuille, quelle que soit la pastille en cours de remplacement.
	 */
	private replacePaletteSwatch(tool: ColorableTool, index: number, anchor: HTMLElement): void {
		const entry = this.plugin.settings.colors[tool];
		const previousActive = entry.active;
		openColorPicker({
			anchor,
			initialColor: entry.palette[index],
			onPreview: (color) => this.previewColorLive(tool, color),
			onCommit: (color) => {
				entry.palette[index] = color;
				entry.active = color;
				void this.plugin.saveSettings();
				this.renderColorPicker();
				this.scheduleActiveRedraw();
			},
			onCancel: () => this.previewColorLive(tool, previousActive),
		});
	}

	/** Aperçu en direct (voir colorPicker.ts:onPreview) : applique `color` à l'outil sans la persister — un Annuler/Échap/clic extérieur la remplace par la couleur précédente sans laisser de trace dans les réglages. */
	private previewColorLive(tool: ColorableTool, color: string): void {
		this.plugin.settings.colors[tool].active = color;
		this.syncColorActiveStates();
		this.scheduleActiveRedraw();
	}

	/**
	 * Ajoute (ou fait remonter) `color` en tête des récents de `tool`,
	 * dédoublonné insensible à la casse, borné à MAX_RECENT_COLORS[tool] (propre
	 * à chaque outil, voir settings.ts). Renvoie vrai si la liste a
	 * effectivement changé, pour éviter une reconstruction du DOM
	 * (renderColorPicker) quand la couleur choisie était déjà la plus récente.
	 */
	private pushRecentColor(tool: ColorableTool, color: string): boolean {
		const entry = this.plugin.settings.colors[tool];
		const before = entry.recent.join(",");
		const normalized = color.toLowerCase();
		entry.recent = entry.recent.filter((c) => c.toLowerCase() !== normalized);
		entry.recent.unshift(color);
		entry.recent = entry.recent.slice(0, MAX_RECENT_COLORS[tool]);
		return entry.recent.join(",") !== before;
	}

	/**
	 * Couleur active de `tool` = `color`. `addToRecent` n'est vrai que pour
	 * une couleur choisie via le sélecteur libre ou le champ hexadécimal — la
	 * liste des récents sert à rendre CE sélecteur réutilisable au
	 * quotidien, pas à dupliquer des teintes déjà visibles en permanence dans
	 * la palette.
	 *
	 * La rangée des récents affiche toujours son contenu en entier, active
	 * comprise (voir renderColorPicker) : seul un changement du contenu de
	 * `entry.recent` lui-même (ajout, dédoublonnage, troncature à
	 * MAX_RECENT_COLORS) justifie une reconstruction complète ; un simple
	 * changement d'active sans toucher aux récents se contente de
	 * syncColorActiveStates(), qui ne fait que déplacer .is-active.
	 */
	private setActiveColor(tool: ColorableTool, color: string, addToRecent: boolean): void {
		const entry = this.plugin.settings.colors[tool];
		entry.active = color;
		const recentChanged = addToRecent && this.pushRecentColor(tool, color);
		void this.plugin.saveSettings();

		if (recentChanged) {
			this.renderColorPicker();
		} else {
			this.syncColorActiveStates();
		}
		this.scheduleActiveRedraw();
	}

	/** Met à jour .is-active sur les pastilles déjà affichées, ET le fond du bouton du sélecteur libre (qui EST la pastille de la couleur active) — sans reconstruire le DOM. Appelée après tout changement de couleur active qui ne touche pas les récents (voir setActiveColor, previewColorLive). */
	private syncColorActiveStates(): void {
		const active = this.activeColor.toLowerCase();
		for (const el of this.paletteSwatchEls) {
			el.toggleClass("is-active", (el.dataset.color ?? "").toLowerCase() === active);
		}
		for (const el of this.recentSwatchEls) {
			el.toggleClass("is-active", (el.dataset.color ?? "").toLowerCase() === active);
		}
		if (this.freePickerButtonEl) {
			this.freePickerButtonEl.setCssStyles({ backgroundColor: this.activeColor });
		}
	}

	private syncToolbarState(): void {
		const tool = this.plugin.settings.tool;
		for (const [t, btn] of this.toolButtons) {
			btn.toggleClass("is-active", t === tool);
		}

		// Le bouton "Formes" n'est pas dans toolButtons (une seule icône pour
		// quatre outils, voir openShapeMenu) : son icône suit la forme active
		// s'il y en a une, sinon reste un pictogramme générique.
		const activeShape = isShapeTool(tool) ? tool : null;
		setIcon(this.shapesMenuBtn, activeShape ? TOOL_ICONS[activeShape] : "shapes");
		const shapesLabel = activeShape ? TOOL_LABELS[activeShape] : "Shapes";
		this.shapesMenuBtn.setAttribute("aria-label", shapesLabel);
		setTooltip(this.shapesMenuBtn, shapesLabel);
		this.shapesMenuBtn.toggleClass("is-active", activeShape !== null);

		if (this.colorsGroupTool !== this.activeColorTool) {
			this.renderColorPicker();
		} else {
			this.syncColorActiveStates();
		}
		// Une forme utilise la même couleur/épaisseur active que le stylo
		// (voir activeColorTool, jamais "highlighter" hors le surligneur
		// lui-même) : la palette reste donc pertinente pour elles aussi,
		// jamais pour le laser (aucune couleur personnalisable, voir
		// LASER_COLOR) ni les gommes.
		const colorRelevant = tool === "pen" || tool === "highlighter" || isShapeTool(tool);
		this.colorsGroupEl.toggleClass("is-irrelevant", !colorRelevant);

		for (const [size, btn] of this.sizeButtons) {
			btn.toggleClass("is-active", size === this.plugin.settings.size);
		}

		this.updateSelectionActionsToolbar();
	}

	/** Force la barre d'outils (palettes de couleurs comprises) à se reconstruire au prochain rendu — appelé depuis la page de réglages (voir main.ts:refreshOpenDrawViews) après une modification d'une palette. */
	refreshToolbar(): void {
		this.colorsGroupTool = null;
		this.syncToolbarState();
	}

	private updateHistoryButtons(): void {
		this.undoBtn?.toggleClass("is-disabled", !this.history.canUndo);
		this.redoBtn?.toggleClass("is-disabled", !this.history.canRedo);
	}

	/**
	 * Affiche ou masque le groupe premier/arrière-plan/verrou selon qu'une
	 * sélection existe, et fait refléter au bouton verrou l'état de la
	 * sélection courante (icône fermée + état "actif" si tout est déjà
	 * verrouillé, ouverte sinon) — appelé à chaque changement de sélection
	 * (setSelection, clearSelection) et de barre d'outils (syncToolbarState).
	 * Un trait ne pouvant pas être verrouillé (voir toggleSelectionLock), le
	 * bouton verrou lui-même reste masqué tant que la sélection ne contient
	 * aucune image — pas seulement grisé, pour ne pas suggérer une action
	 * possible qui ne ferait rien.
	 */
	private updateSelectionActionsToolbar(): void {
		if (!this.selectionActionsGroupEl) return;
		const hasSelection = this.selectedIds.size > 0;
		this.selectionActionsGroupEl.toggleClass("is-hidden", !hasSelection);
		if (!hasSelection) return;

		const page = this.selectedPageIndex !== null ? this.pages[this.selectedPageIndex].page : null;
		const hasImage = page ? page.elements.some((el) => this.selectedIds.has(el.id) && el.type === "image") : false;
		this.lockBtn.toggleClass("is-hidden", !hasImage);

		// Rogner une sélection de plusieurs images à la fois n'aurait pas de
		// sens (chacune a son propre contenu à cadrer) : le bouton n'apparaît
		// que pour EXACTEMENT une image sélectionnée, jamais pour plusieurs
		// ni pour un trait/une forme (voir openCropDialog).
		const selectedImageCount = page
			? page.elements.filter((el) => this.selectedIds.has(el.id) && el.type === "image").length
			: 0;
		this.cropBtn.toggleClass("is-hidden", selectedImageCount !== 1);

		if (!hasImage) return;

		const locked = this.isSelectionFullyLocked();
		this.lockBtn.toggleClass("is-active", locked);
		setIcon(this.lockBtn, locked ? "lock" : "lock-open");
		const label = locked ? "Unlock" : "Lock";
		this.lockBtn.setAttribute("aria-label", label);
		setTooltip(this.lockBtn, label);
	}

	/** Le stylo et le surligneur ont chacun leur palette/récents propres (voir ToolColorSettings) ; les deux gommes n'ont pas de couleur, et retombent sur celle du stylo par convention. */
	private get activeColorTool(): ColorableTool {
		return this.plugin.settings.tool === "highlighter" ? "highlighter" : "pen";
	}

	private get activeColor(): string {
		return this.plugin.settings.colors[this.activeColorTool].active;
	}

	private get eraserRadius(): number {
		return this.plugin.settings.size * ERASER_RADIUS_SCALE;
	}

	private setTool(tool: ActiveTool): void {
		this.plugin.settings.tool = tool;
		void this.plugin.saveSettings();
		this.returnToPenAfterDeselect = false;
		this.autoSelectShapeId = null;
		if (tool !== "eraser-zone") {
			this.eraserPreviewPoint = null;
			this.eraserPreviewPageIndex = null;
		}
		// Quitter le laser efface immédiatement sa traînée plutôt que de la
		// laisser s'estomper toute seule (voir LASER_FADE_MS) : une fois un
		// autre outil choisi, elle n'a plus rien à voir avec ce qu'on fait.
		if (tool !== "laser") this.laserPoints = [];
		// La sélection n'a de sens qu'avec le curseur ou le lasso actif : en
		// changer pour un autre outil sans la vider laisserait un cadre
		// englobant sans rapport avec ce qu'on dessine ou efface ensuite. Basculer
		// entre curseur et lasso, en revanche, garde la sélection courante.
		if (!isSelectionTool(tool)) {
			this.selectedIds.clear();
			this.selectedPageIndex = null;
		}
		this.syncToolbarState();
		this.updateCursor();
		this.scheduleActiveRedraw();
	}

	private setSize(size: number): void {
		this.plugin.settings.size = size;
		void this.plugin.saveSettings();
		this.syncToolbarState();
	}

	// --- Fond, densité, format, orientation (propriétés de la page) ------------

	/**
	 * Le fond, la densité et l'orientation sont des propriétés d'UNE PAGE
	 * (`DrawingPage`), pas des réglages du plugin : elles vivent dans le
	 * .draw, pas dans loadData()/saveData(). Le changement invalide le cache
	 * du fond et déclenche un redessin — mais implicitement : `drawBackground`
	 * (render.ts) met en cache par (type, dimensions, couleurs, densité), donc
	 * changer l'une de ces valeurs produit automatiquement une nouvelle clé,
	 * sans appel explicite à « vider le cache ». Chaque changement est
	 * annulable par Ctrl+Z comme les autres modifications, mais seulement sur
	 * la page concernée (voir history.ts).
	 */
	private setBackground(pageIndex: number, kind: BackgroundKind): void {
		const rt = this.pages[pageIndex];
		if (!rt || kind === rt.page.background) return;
		const from = rt.page.background;
		rt.page.background = kind;
		this.history.push(pageIndex, { type: "background", from, to: kind });
		this.updateHistoryButtons();
		this.requestSave();
		this.render(pageIndex);
	}

	private setDensity(pageIndex: number, density: Density): void {
		const rt = this.pages[pageIndex];
		if (!rt || density === rt.page.density) return;
		const from = rt.page.density;
		rt.page.density = density;
		this.history.push(pageIndex, { type: "density", from, to: density });
		this.updateHistoryButtons();
		this.requestSave();
		this.render(pageIndex);
	}

	/**
	 * Échange width et height de la page (voir toggleOrientation, model.ts) :
	 * les traits existants gardent leurs coordonnées telles quelles, on ne
	 * touche qu'au cadre. Un trait peut donc se retrouver hors de la page
	 * visible après une rotation ; il n'est pas supprimé. render(pageIndex)
	 * régénère le cache de cette page (nouvelles dimensions) ET relayoute le
	 * document entier (voir DrawView.render) : les pages suivantes se
	 * décalent verticalement si celle-ci change de hauteur.
	 */
	private setOrientation(pageIndex: number, orientation: Orientation): void {
		const rt = this.pages[pageIndex];
		if (!rt || orientation === rt.page.orientation) return;
		const from = rt.page.orientation;
		toggleOrientation(rt.page);
		this.history.push(pageIndex, { type: "orientation", from, to: orientation });
		this.updateHistoryButtons();
		this.requestSave();
		this.render(pageIndex);
	}

	/**
	 * Applique les dimensions de `format` (voir PAPER_FORMAT_SIZES, model.ts,
	 * exprimées en portrait) à la page — en respectant son orientation
	 * ACTUELLE plutôt que de la réinitialiser en portrait : passer de A4 à A3
	 * sur une page déjà en paysage doit rester en paysage. Les traits
	 * existants gardent leurs coordonnées telles quelles, comme pour
	 * setOrientation — un trait peut donc se retrouver hors de la page si le
	 * nouveau format est plus petit.
	 */
	private setFormat(pageIndex: number, format: PaperFormat): void {
		const rt = this.pages[pageIndex];
		if (!rt) return;
		const size = PAPER_FORMAT_SIZES[format];
		const to =
			rt.page.orientation === "landscape"
				? { width: size.height, height: size.width }
				: { width: size.width, height: size.height };
		if (to.width === rt.page.width && to.height === rt.page.height) return;
		const from = { width: rt.page.width, height: rt.page.height };
		rt.page.width = to.width;
		rt.page.height = to.height;
		this.history.push(pageIndex, { type: "format", from, to });
		this.updateHistoryButtons();
		this.requestSave();
		this.render(pageIndex);
	}

	// --- Annuler / rétablir -----------------------------------------------------

	private undo(): void {
		const entry = this.history.undo();
		if (!entry) return;
		this.applyHistoryEntry(entry, false);
	}

	private redo(): void {
		const entry = this.history.redo();
		if (!entry) return;
		this.applyHistoryEntry(entry, true);
	}

	/**
	 * `forward` distingue rejouer (redo) de rejouer à l'envers (undo) — les
	 * deux formes d'entrée de l'historique (voir HistoryEntry) ont chacune
	 * leur propre paire de fonctions avant/inverse (applyForward/Inverse pour
	 * une action classique, applyMovePagesForward/Inverse pour un
	 * déplacement entre pages), jamais mélangées.
	 */
	private applyHistoryEntry(entry: HistoryEntry, forward: boolean): void {
		if (entry.kind === "action") {
			const rt = this.pages[entry.pageIndex];
			if (!rt) return; // page supprimée depuis (History.removePage est censé prévenir ce cas ; filet de sécurité)
			(forward ? applyForward : applyInverse)(rt.page, entry.action);
			this.updateHistoryButtons();
			this.render(entry.pageIndex);
			this.requestSave();
			return;
		}

		const fromRt = this.pages[entry.move.fromPage];
		const toRt = this.pages[entry.move.toPage];
		if (!fromRt || !toRt) return; // une des deux pages supprimée depuis ; filet de sécurité, voir ci-dessus
		(forward ? applyMovePagesForward : applyMovePagesInverse)(fromRt.page, toRt.page, entry.move);
		this.updateHistoryButtons();
		this.render(entry.move.fromPage);
		this.render(entry.move.toPage);
		this.requestSave();
	}

	// --- Coordonnées d'un événement pointeur -------------------------------------

	/**
	 * Repère écran -> repère document, en passant par getBoundingClientRect()
	 * (position du canvas) puis screenToDocument() (cadrage courant). Seule
	 * fonction du plugin à faire cette conversion pour un événement pointeur —
	 * jamais directement le repère d'une page : c'est au geste de résoudre
	 * (une seule fois, à son démarrage — voir hitPage) sur quelle page il
	 * porte, puis de s'y tenir pour toute sa durée.
	 */
	private eventToXY(event: PointerEvent, rect: DOMRect): [number, number] {
		return this.screenToDocument(event.clientX - rect.left, event.clientY - rect.top);
	}

	/** Repère d'une page -> même repère, ramené dans les limites de CETTE page : le crayon, le surligneur et le déplacement d'une sélection (voir updateTransform) s'arrêtent net au bord plutôt que de continuer hors page. */
	private clampToPage(pageIndex: number, x: number, y: number): [number, number] {
		const rt = this.pages[pageIndex];
		return [clamp(x, 0, rt.page.width), clamp(y, 0, rt.page.height)];
	}

	private clampPointToPage(pageIndex: number, pt: Pt): Pt {
		const [x, y] = this.clampToPage(pageIndex, pt[0], pt[1]);
		return [x, y, pt[2]];
	}

	// --- Conversion d'un trait en ligne droite par maintien ----------------------
	//
	// Portée stylo/surligneur uniquement : cette logique n'est jamais invoquée
	// pour la gomme, qui ne passe jamais par activeStroke (voir
	// eraseZoneSession/eraseStrokeSession). Deux façons d'entrer en mode ligne
	// droite : Maj dès le pointerdown (immédiat, voir onPointerDown), ou un
	// maintien immobile d'environ straightenHoldDelayMs (voir armStillnessTimer,
	// réarmé par updateStillnessTimer à chaque mouvement dépassant le seuil).
	// Une fois converti, activeStroke.points contient TOUJOURS exactement 2
	// points (origine, extrémité libre) — voir updateStraightLine, qui est
	// l'unique endroit qui les modifie ensuite.

	/** (Ré)arme le minuteur de conversion à `point` (repère de la page du trait en cours) : tout appel ultérieur avant son expiration l'annule et le redémarre (voir updateStillnessTimer). */
	private armStillnessTimer(point: [number, number]): void {
		this.clearStillnessTimer();
		this.strokeHoldAnchor = point;
		this.strokeHoldTimer = window.setTimeout(() => {
			this.strokeHoldTimer = null;
			this.triggerHoldConversion();
		}, this.plugin.settings.straightenHoldDelayMs);
	}

	private clearStillnessTimer(): void {
		if (this.strokeHoldTimer !== null) {
			window.clearTimeout(this.strokeHoldTimer);
			this.strokeHoldTimer = null;
		}
		this.strokeHoldAnchor = null;
	}

	/** Appelé pour chaque point freehand capturé tant que le trait n'est pas encore converti : réarme le minuteur dès que le point s'éloigne de plus de STRAIGHTEN_STILL_THRESHOLD_PX de l'ancre courante. */
	private updateStillnessTimer(point: [number, number]): void {
		if (!this.plugin.settings.straightenOnHold) return;
		if (!this.strokeHoldAnchor) {
			this.armStillnessTimer(point);
			return;
		}
		const dist = Math.hypot(point[0] - this.strokeHoldAnchor[0], point[1] - this.strokeHoldAnchor[1]);
		if (dist > STRAIGHTEN_STILL_THRESHOLD_PX) {
			this.armStillnessTimer(point);
		}
	}

	/**
	 * Point d'entrée unique du minuteur d'immobilité (jamais pour Maj dès le
	 * pointerdown, qui va toujours droit à triggerStraighten — voir
	 * onPointerDown) : essaie d'abord de reconnaître le tracé comme un rond,
	 * un rectangle ou un triangle (voir recognizeClosedShape) ; sinon, s'il
	 * ne forme pas une boucle refermée, retombe sur la conversion en ligne
	 * droite existante. Un tracé refermé mais NON reconnu (un gribouillis
	 * fermé quelconque) ne déclenche rien : mieux vaut le laisser tel quel
	 * que le réduire à une ligne quasi nulle entre un premier et un dernier
	 * point presque confondus.
	 */
	private triggerHoldConversion(): void {
		if (!this.activeStroke || this.straightLine || this.recognizedShape || this.activeStrokePageIndex === null) return;

		const candidate = this.recognizeClosedShape(this.activeStroke.points);
		if (candidate) {
			this.clearStillnessTimer();
			this.recognizedShape = {
				id: this.activeStroke.id,
				type: "shape",
				shape: candidate.shape,
				x: candidate.x,
				y: candidate.y,
				width: candidate.width,
				height: candidate.height,
				rotation: 0,
				color: this.activeStroke.color,
				size: this.activeStroke.size,
			};
			this.recognizedShapeAnchor = {
				cx: candidate.x + candidate.width / 2,
				cy: candidate.y + candidate.height / 2,
				baseWidth: candidate.width,
				baseHeight: candidate.height,
			};
			if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
				navigator.vibrate(STRAIGHTEN_HAPTIC_MS);
			}
			this.scheduleActiveRedraw();
			return;
		}

		if (!this.isClosedPath(this.activeStroke.points)) {
			this.triggerStraighten(false);
		}
	}

	/**
	 * Vrai si le tracé se referme à peu près sur son point de départ — voir
	 * CLOSED_PATH_GAP_RATIO. Sert à la fois de garde d'entrée à
	 * recognizeClosedShape (une forme ouverte n'est jamais un rond/rectangle/
	 * triangle) et à décider, en cas d'échec de reconnaissance, si un repli
	 * vers la ligne droite a un sens (seulement pour un tracé encore ouvert).
	 */
	private isClosedPath(points: Pt[]): boolean {
		if (points.length < 4) return false;
		const [sx, sy] = points[0];
		const [ex, ey] = points[points.length - 1];
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const [x, y] of points) {
			if (x < minX) minX = x;
			if (y < minY) minY = y;
			if (x > maxX) maxX = x;
			if (y > maxY) maxY = y;
		}
		const diag = Math.hypot(maxX - minX, maxY - minY);
		if (diag < 1e-6) return false;
		return Math.hypot(ex - sx, ey - sy) / diag < CLOSED_PATH_GAP_RATIO;
	}

	/**
	 * Reconnaît un tracé refermé comme un rond, un rectangle ou un triangle —
	 * `null` s'il est trop court, trop petit, encore ouvert, ou qu'aucun des
	 * trois ne correspond avec assez de confiance (voir les constantes
	 * RECOGNIZE_MIN_POINTS, RECOGNIZE_MIN_SIZE_PX, CLOSED_PATH_GAP_RATIO,
	 * CIRCLE_ROUNDNESS_THRESHOLD, CORNER_SIMPLIFY_RATIO en tête de fichier).
	 * Heuristique volontairement
	 * simple plutôt qu'un vrai moteur de reconnaissance de gestes :
	 *  1. Rond : le coefficient de variation des distances de chaque point au
	 *     centroïde — bas pour un cercle (rayon à peu près constant), élevé
	 *     dès que des coins marqués s'écartent nettement de la moyenne.
	 *  2. Sinon, coins dominants : une simplification RDP volontairement
	 *     agressive (voir simplify.ts) ne garde que les sommets marqués —
	 *     3 sommets restants = triangle, 4 = rectangle, tout le reste
	 *     (2, 5 ou plus) = pas reconnu.
	 * La boîte englobante réelle du tracé sert de géométrie à la forme
	 * reconnue dans tous les cas — jamais les sommets exacts détectés, voir
	 * ShapeElement (model.ts) : "propre" prime sur "fidèle au tracé".
	 */
	private recognizeClosedShape(
		points: Pt[]
	): { shape: ShapeKind; x: number; y: number; width: number; height: number } | null {
		if (points.length < RECOGNIZE_MIN_POINTS) return null;
		if (!this.isClosedPath(points)) return null;

		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		let sumX = 0;
		let sumY = 0;
		for (const [x, y] of points) {
			if (x < minX) minX = x;
			if (y < minY) minY = y;
			if (x > maxX) maxX = x;
			if (y > maxY) maxY = y;
			sumX += x;
			sumY += y;
		}
		const width = maxX - minX;
		const height = maxY - minY;
		if (width < RECOGNIZE_MIN_SIZE_PX || height < RECOGNIZE_MIN_SIZE_PX) return null;

		// Des coins nets sont un indice bien plus spécifique qu'un faible
		// coefficient de variation : un carré/rectangle tracé à main levée a
		// souvent lui aussi une variation assez basse (les quatre coins ne
		// s'écartent du centre que d'un facteur √2 par rapport aux milieux de
		// côté), ce qui le faisait auparavant passer pour un rond avant même
		// d'atteindre ce test — voir le bug signalé ("il me fait trop
		// facilement des ronds au lieu des carrés"). Les coins passent donc
		// EN PREMIER ; le rond n'est plus qu'un repli pour tout ce qui ne
		// simplifie pas proprement en 3 ou 4 sommets (un vrai cercle, avec sa
		// courbure continue, ne s'y réduit presque jamais).
		const tolerance = Math.max(width, height) * CORNER_SIMPLIFY_RATIO;
		const simplified = simplifyPoints(points, tolerance);
		// Un tracé fermé simplifié revient quasiment sur son premier point :
		// ce dernier point ne compte pas comme un sommet distinct.
		const vertexCount = simplified.length > 1 ? simplified.length - 1 : simplified.length;

		if (vertexCount === 3) return { shape: "triangle", x: minX, y: minY, width, height };
		if (vertexCount === 4) return { shape: "rectangle", x: minX, y: minY, width, height };

		const cx = sumX / points.length;
		const cy = sumY / points.length;

		let sumDist = 0;
		const dists: number[] = [];
		for (const [x, y] of points) {
			const d = Math.hypot(x - cx, y - cy);
			dists.push(d);
			sumDist += d;
		}
		const meanDist = sumDist / dists.length;
		if (meanDist < 1e-6) return null;
		let variance = 0;
		for (const d of dists) variance += (d - meanDist) ** 2;
		variance /= dists.length;
		const coeffVar = Math.sqrt(variance) / meanDist;

		if (coeffVar < CIRCLE_ROUNDNESS_THRESHOLD) {
			return { shape: "ellipse", x: minX, y: minY, width, height };
		}
		return null;
	}

	/**
	 * Poursuit l'ajustement d'une forme reconnue tant que le pointeur reste
	 * enfoncé (voir recognizedShapeAnchor) : la distance courante au centre,
	 * rapportée à celle mesurée au moment de la reconnaissance, sert de
	 * facteur d'échelle uniforme — jamais un redimensionnement par coin
	 * comme pour une sélection, le tracé d'origine n'ayant pas de poignée
	 * évidente à saisir. Toujours centrée sur son centre d'origine, et
	 * jamais agrandie au-delà des limites de la page.
	 */
	private updateRecognizedShapeScale(current: [number, number]): void {
		const shape = this.recognizedShape;
		const anchor = this.recognizedShapeAnchor;
		if (!shape || !anchor || this.activeStrokePageIndex === null) return;

		const baseRadius = Math.hypot(anchor.baseWidth / 2, anchor.baseHeight / 2);
		if (baseRadius < 1e-6) return;
		const dist = Math.hypot(current[0] - anchor.cx, current[1] - anchor.cy);
		const scale = clamp(dist / baseRadius, 0.2, 5);

		const page = this.pages[this.activeStrokePageIndex].page;
		const maxHalfWidth = Math.min(anchor.cx, page.width - anchor.cx);
		const maxHalfHeight = Math.min(anchor.cy, page.height - anchor.cy);
		const halfWidth = Math.min((anchor.baseWidth * scale) / 2, Math.max(0, maxHalfWidth));
		const halfHeight = Math.min((anchor.baseHeight * scale) / 2, Math.max(0, maxHalfHeight));

		shape.x = anchor.cx - halfWidth;
		shape.y = anchor.cy - halfHeight;
		shape.width = halfWidth * 2;
		shape.height = halfHeight * 2;
	}

	/**
	 * Convertit le trait en cours en segment droit reliant son premier et son
	 * dernier point (`isDirect` = false, déclenché par le minuteur d'immobilité)
	 * ou reliant son unique point à lui-même (`isDirect` = true, Maj dès le
	 * pointerdown — rien à convertir, la ligne se construira au fil du
	 * glissement). La pression de tous les points capturés jusqu'ici devient la
	 * moyenne qui pilotera l'épaisseur constante du segment (voir
	 * updateStraightLine, qui continue d'accumuler les pressions ultérieures).
	 */
	private triggerStraighten(isDirect: boolean): void {
		if (!this.activeStroke || this.straightLine || this.activeStrokePageIndex === null) return;
		this.clearStillnessTimer();

		const pts = this.activeStroke.points;
		const origin = pts[0];
		const last = pts[pts.length - 1];

		// Accumule tous les points SAUF le dernier : celui-ci est ajouté une
		// seule fois juste en dessous, via updateStraightLine — l'y compter ici
		// aussi le pondérerait deux fois dans la moyenne.
		let pressureSum = 0;
		for (let i = 0; i < pts.length - 1; i++) pressureSum += pts[i][2];

		this.straightLine = {
			originXY: [origin[0], origin[1]],
			pressureSum,
			pressureCount: pts.length - 1,
			snapAngleDeg: null,
		};

		this.updateStraightLine(this.activeStrokePageIndex, [last[0], last[1]], false, false, last[2]);

		if (!isDirect) this.playStraightenFeedback();
	}

	/**
	 * Recalcule l'extrémité libre du segment à partir d'une position brute
	 * (repère de `pageIndex`), avec aimantation angulaire : à moins de
	 * ANGLE_SNAP_TOLERANCE_DEG d'un multiple de 15°, ou Maj maintenue (aimante
	 * toujours), sauf Alt maintenue (n'aimante jamais). Réécrit
	 * activeStroke.points en 2 points dont la pression est la moyenne courante
	 * — c'est cette identité de pression aux deux extrémités qui garantit une
	 * épaisseur constante côté rendu (voir render.ts:drawPenStroke, cas à 2 points).
	 */
	private updateStraightLine(pageIndex: number, rawEnd: [number, number], shiftKey: boolean, altKey: boolean, pressure: number): void {
		const sl = this.straightLine;
		if (!sl || !this.activeStroke) return;

		sl.pressureSum += pressure;
		sl.pressureCount += 1;
		const avgPressure = sl.pressureSum / sl.pressureCount;

		const [ox, oy] = sl.originXY;
		let ex = rawEnd[0];
		let ey = rawEnd[1];
		const dx = ex - ox;
		const dy = ey - oy;
		const dist = Math.hypot(dx, dy);

		let angleDeg: number | null = null;
		if (dist > 0.001) {
			const rawAngle = Math.atan2(dy, dx) * (180 / Math.PI);
			const snappedAngle = Math.round(rawAngle / ANGLE_SNAP_STEP_DEG) * ANGLE_SNAP_STEP_DEG;
			let diff = Math.abs(rawAngle - snappedAngle);
			if (diff > 180) diff = 360 - diff;
			const shouldSnap = !altKey && (shiftKey || diff <= ANGLE_SNAP_TOLERANCE_DEG);
			angleDeg = shouldSnap ? snappedAngle : rawAngle;

			const rad = angleDeg * (Math.PI / 180);
			ex = ox + Math.cos(rad) * dist;
			ey = oy + Math.sin(rad) * dist;
		}

		sl.snapAngleDeg = angleDeg;
		// L'angle s'aimante sur la direction brute avant tout rognage : clamper
		// l'extrémité seulement ici, une fois la direction choisie, arrête le
		// segment net au bord de la feuille sans en changer l'angle.
		const [cox, coy] = this.clampToPage(pageIndex, ox, oy);
		const [cex, cey] = this.clampToPage(pageIndex, ex, ey);
		this.activeStroke.points = [
			[cox, coy, avgPressure],
			[cex, cey, avgPressure],
		];
	}

	/** Retour bref (visuel + haptique) signalant une conversion par maintien — jamais pour Maj, geste déjà volontaire dont le résultat n'a rien de surprenant. */
	private playStraightenFeedback(): void {
		if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
			navigator.vibrate(STRAIGHTEN_HAPTIC_MS);
		}
		this.startStraightenFlash();
	}

	/** Anime le halo de conversion indépendamment des événements pointeur : se replanifie lui-même tant que STRAIGHTEN_FLASH_MS n'est pas écoulé, pour continuer même si l'utilisateur reste parfaitement immobile. */
	private startStraightenFlash(): void {
		this.straightenFlashStart = performance.now();
		const tick = (): void => {
			if (this.straightenFlashStart === null) return;
			const elapsed = performance.now() - this.straightenFlashStart;
			this.scheduleActiveRedraw();
			if (elapsed >= STRAIGHTEN_FLASH_MS) {
				this.straightenFlashStart = null;
				this.straightenFlashHandle = null;
				return;
			}
			this.straightenFlashHandle = window.requestAnimationFrame(tick);
		};
		this.straightenFlashHandle = window.requestAnimationFrame(tick);
	}

	/** Remet à zéro tout l'état de conversion : minuteur, ligne droite en cours, forme reconnue en cours, animation. À appeler à chaque fin de geste (validée ou annulée) et à la fermeture de la vue. */
	private resetStraightLineState(): void {
		this.clearStillnessTimer();
		this.straightLine = null;
		this.recognizedShape = null;
		this.recognizedShapeAnchor = null;
		this.straightenFlashStart = null;
		if (this.straightenFlashHandle !== null) {
			window.cancelAnimationFrame(this.straightenFlashHandle);
			this.straightenFlashHandle = null;
		}
	}

	// --- Capture du geste (trait, gomme, panoramique, pincement) -----------------

	private onPointerDown = (event: PointerEvent): void => {
		if (event.button === 2) return; // clic droit réservé au menu contextuel (voir onContextMenu) : jamais un trait ni une gomme, quel que soit l'outil actif

		this.contentEl.focus();

		if (event.pointerType === "pen") {
			this.lastPenActiveAt = performance.now();
		}

		if (event.pointerType === "touch") {
			// Rejet de la paume : un SEUL doigt après usage du stylet est ignoré.
			// Plusieurs doigts simultanés (pincement/panoramique) restent
			// acceptés même juste après avoir écrit au stylet — la paume pose un
			// seul contact, un geste de navigation volontaire en pose deux.
			const alreadyHasTouch = this.countActiveTouches() > 0;
			if (!alreadyHasTouch && performance.now() - this.lastPenActiveAt < PALM_REJECTION_MS) {
				this.ignoredPointerIds.add(event.pointerId);
				return;
			}
		}

		this.committedCanvas.setPointerCapture(event.pointerId);
		this.pointers.set(event.pointerId, event);

		const activeTouches = this.countActiveTouches();
		if (activeTouches === 2) {
			event.preventDefault();
			this.clearLongPressMenu(); // un deuxième doigt rejoint : c'est un pincement, plus un appui long candidat
			this.startPinchGesture();
			return;
		}
		if (activeTouches > 2) return; // au-delà de deux doigts, on ignore le reste du geste

		if (this.viewportGesture) return; // un panoramique/pincement est déjà en cours

		if (this.isPanTrigger(event)) {
			event.preventDefault();
			this.startPanGesture(event);
			return;
		}

		if (this.activePointerId !== null) return; // un seul trait/gomme à la fois

		const rect = this.committedCanvas.getBoundingClientRect();
		const tool = this.plugin.settings.tool;
		const [docX, docY] = this.eventToXY(event, rect);

		if (tool === "laser") {
			// Aucune page nécessaire : le pointeur laser vise l'écran, pas le
			// contenu — repère document directement, jamais celui d'une page
			// (voir laserPoints). Fonctionne donc même dans la marge entre deux
			// pages, contrairement à tout autre outil.
			event.preventDefault();
			this.activePointerId = event.pointerId;
			this.laserPoints.push({ x: docX, y: docY, t: performance.now() });
			this.scheduleLaserAnimation();
			this.scheduleActiveRedraw();
			return;
		}

		// L'outil main ne dessine ni ne sélectionne jamais : un clic gauche
		// panoramique déjà (voir isPanTrigger, plus haut dans cette méthode) ;
		// tout AUTRE bouton (droit, ou tactile puisque isPanTrigger ignore le
		// tactile) atterrit ici et ne doit rien déclencher du tout, plutôt que
		// de retomber sur le comportement par défaut du stylo tout en bas de
		// cette méthode.
		if (tool === "hand") return;

		const pageIndex = this.hitPage(docX, docY);
		if (pageIndex === null) {
			// Clic dans la marge entre deux pages, ou hors de toute page : rien à
			// commencer — ni trait, ni gomme, ni sélection (voir hitPage).
			return;
		}

		event.preventDefault();
		this.activePointerId = event.pointerId;
		this.focusedPageIndex = pageIndex;

		// Sur tablette, un appui immobile assez long ouvre le menu contextuel
		// (voir triggerLongPressMenu) — quel que soit l'outil actif, y compris
		// la gomme. Coordonnées écran : ce minuteur ne dessine rien.
		if (event.pointerType === "touch") {
			this.armLongPressMenu(event.clientX, event.clientY);
		}

		const [x, y] = this.toPageLocal(pageIndex, docX, docY);

		if (isSelectionTool(tool)) {
			this.onSelectPointerDown(event, pageIndex, x, y, tool === "select");
			return;
		}

		if (tool === "capture") {
			// Toujours un rectangle (jamais un lasso) : une capture est une zone
			// rectangulaire, comme une capture d'écran — voir finishCapture, qui
			// réutilise le même mécanisme de marquee que le lasso/curseur pour son
			// aperçu en pointillés (voir render()), mais le finalise autrement.
			this.startMarquee(pageIndex, x, y, true);
			return;
		}

		if (tool === "eraser-zone") {
			// Traits ET formes entrent dans l'instantané : la gomme les touche
			// tous les deux (voir eraseZoneAt), jamais une image (voir
			// EraseZoneSession). L'index conservé est celui dans page.elements
			// (pas un sous-index parmi un seul type), c'est à cette position
			// exacte qu'un undo doit réinsérer l'élément.
			const page = this.pages[pageIndex].page;
			const originalSnapshot = new Map<string, { index: number; element: DrawElement }>();
			page.elements.forEach((el, i) => {
				if (el.type === "stroke" || el.type === "shape") originalSnapshot.set(el.id, { index: i, element: el });
			});
			this.eraseZoneSession = { pageIndex, originalSnapshot, touchedOriginalIds: new Set(), liveFragmentIds: new Set() };
			this.eraserPreviewPageIndex = pageIndex;
			this.eraseZoneAt([x, y]);
			return;
		}

		if (tool === "eraser-stroke") {
			// Contrairement à la gomme de zone, celle-ci efface l'élément entier
			// qu'elle touche — trait ou image confondus (voir eraseStrokeAt) : à
			// la différence d'un effacement partiel par fragments, "l'élément
			// entier" a un sens identique pour les deux types.
			const page = this.pages[pageIndex].page;
			const originalIndex = new Map<string, number>();
			page.elements.forEach((el, i) => originalIndex.set(el.id, i));
			this.eraseStrokeSession = { pageIndex, originalIndex, removed: [] };
			this.eraseStrokeAt([x, y]);
			return;
		}

		if (isShapeTool(tool)) {
			this.activeShapePageIndex = pageIndex;
			this.activeShapeStart = [x, y];
			this.activeShape = {
				id: newStrokeId(),
				type: "shape",
				shape: tool,
				x,
				y,
				width: 0,
				height: 0,
				rotation: 0,
				color: this.activeColor,
				size: this.plugin.settings.size,
			};
			this.updateActiveShape([x, y], event.shiftKey);
			this.scheduleActiveRedraw();
			return;
		}

		const size =
			tool === "highlighter" ? this.plugin.settings.size * HIGHLIGHTER_SIZE_MULTIPLIER : this.plugin.settings.size;
		this.activeStroke = {
			id: newStrokeId(),
			type: "stroke",
			tool,
			color: this.activeColor,
			size,
			points: [this.clampPointToPage(pageIndex, [x, y, event.pressure])],
		};
		this.activeStrokePageIndex = pageIndex;

		// Modificateur direct : Maj dès le pointerdown produit une ligne droite
		// sans délai, indépendamment du réglage de conversion par maintien.
		if (event.shiftKey) {
			this.triggerStraighten(true);
		} else if (this.plugin.settings.straightenOnHold) {
			this.armStillnessTimer([x, y]);
		}
		this.scheduleActiveRedraw();
	};

	private onPointerMove = (event: PointerEvent): void => {
		if (this.ignoredPointerIds.has(event.pointerId)) return;
		if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, event);

		// Survol (souris/stylet seulement — voir hoveredPageIndex) pour
		// positionner le bouton de suppression discret d'une page (voir
		// updateHoverPageButtons), même hors de tout geste.
		if (event.pointerType !== "touch" && this.activePointerId === null && !this.viewportGesture && this.committedCanvas) {
			const rect = this.committedCanvas.getBoundingClientRect();
			const [docX, docY] = this.screenToDocument(event.clientX - rect.left, event.clientY - rect.top);
			const hovered = this.hitPageForHover(docX, docY);
			if (hovered !== this.hoveredPageIndex) {
				this.hoveredPageIndex = hovered;
				this.scheduleViewportRedraw();
			}
		}

		if (this.viewportGesture) {
			this.updateViewportGesture(event);
			return;
		}

		const rect = this.committedCanvas.getBoundingClientRect();

		// Prévisualisation de la gomme au survol, même sans geste actif.
		if (this.plugin.settings.tool === "eraser-zone" && this.activePointerId === null) {
			const [docX, docY] = this.eventToXY(event, rect);
			const pageIndex = this.hitPage(docX, docY);
			this.eraserPreviewPageIndex = pageIndex;
			this.eraserPreviewPoint = pageIndex !== null ? this.toPageLocal(pageIndex, docX, docY) : null;
			this.scheduleActiveRedraw();
		}

		if (event.pointerId !== this.activePointerId) return;

		if (event.pointerType === "touch") this.updateLongPressMenu(event.clientX, event.clientY);

		const coalesced = event.getCoalescedEvents?.() ?? [];
		const source = coalesced.length > 0 ? coalesced : [event];

		if (this.plugin.settings.tool === "laser") {
			for (const e of source) {
				const [docX, docY] = this.eventToXY(e, rect);
				this.laserPoints.push({ x: docX, y: docY, t: performance.now() });
			}
			this.scheduleActiveRedraw();
			return;
		}

		if (this.eraseZoneSession) {
			const session = this.eraseZoneSession;
			for (const e of source) {
				const [docX, docY] = this.eventToXY(e, rect);
				const p = this.toPageLocal(session.pageIndex, docX, docY);
				this.eraserPreviewPoint = p;
				this.eraserPreviewPageIndex = session.pageIndex;
				this.eraseZoneAt(p);
			}
			this.scheduleActiveRedraw();
			return;
		}

		if (this.eraseStrokeSession) {
			const session = this.eraseStrokeSession;
			for (const e of source) {
				const [docX, docY] = this.eventToXY(e, rect);
				this.eraseStrokeAt(this.toPageLocal(session.pageIndex, docX, docY));
			}
			return;
		}

		if (this.transformSession) {
			const session = this.transformSession;
			const last = source[source.length - 1];
			const [docX, docY] = this.eventToXY(last, rect);
			const [x, y] = this.toPageLocal(session.pageIndex, docX, docY);
			this.updateTransform([x, y], last.shiftKey);
			return;
		}

		if (this.activeMarquee) {
			const marquee = this.activeMarquee;
			const last = source[source.length - 1];
			const [docX, docY] = this.eventToXY(last, rect);
			const [x, y] = this.toPageLocal(marquee.pageIndex, docX, docY);
			this.updateMarquee(x, y);
			return;
		}

		if (this.activeShape && this.activeShapePageIndex !== null) {
			const pageIndex = this.activeShapePageIndex;
			const last = source[source.length - 1];
			const [docX, docY] = this.eventToXY(last, rect);
			const [x, y] = this.toPageLocal(pageIndex, docX, docY);
			this.updateActiveShape([x, y], last.shiftKey);
			this.scheduleActiveRedraw();
			return;
		}

		if (!this.activeStroke || this.activeStrokePageIndex === null) return;
		const pageIndex = this.activeStrokePageIndex;

		if (this.straightLine) {
			// Une fois converti, seule l'extrémité libre du segment bouge : le
			// dernier échantillon coalescé suffit, nul besoin de rejouer tout le lot.
			const last = source[source.length - 1];
			const [docX, docY] = this.eventToXY(last, rect);
			const [ex, ey] = this.toPageLocal(pageIndex, docX, docY);
			this.updateStraightLine(pageIndex, [ex, ey], last.shiftKey, last.altKey, last.pressure);
			this.scheduleActiveRedraw();
			return;
		}

		if (this.recognizedShape) {
			// Une forme a été reconnue : le glissement restant ne fait plus que la
			// redimensionner autour de son centre (voir updateRecognizedShapeScale),
			// le tracé au stylo/surligneur sous-jacent n'est plus mis à jour.
			const last = source[source.length - 1];
			const [docX, docY] = this.eventToXY(last, rect);
			const [ex, ey] = this.toPageLocal(pageIndex, docX, docY);
			this.updateRecognizedShapeScale([ex, ey]);
			this.scheduleActiveRedraw();
			return;
		}

		for (const e of source) {
			const [docX, docY] = this.eventToXY(e, rect);
			const [rawX, rawY] = this.toPageLocal(pageIndex, docX, docY);
			const [x, y] = this.clampToPage(pageIndex, rawX, rawY);
			this.activeStroke.points.push([x, y, e.pressure]);
			this.updateStillnessTimer([x, y]);
		}
		this.scheduleActiveRedraw();
	};

	private onPointerUp = (event: PointerEvent): void => {
		this.ignoredPointerIds.delete(event.pointerId);
		this.pointers.delete(event.pointerId);
		this.clearLongPressMenu();

		if (this.viewportGesture) {
			this.maybeEndViewportGesture(event.pointerId);
			return;
		}

		if (event.pointerId !== this.activePointerId) return;

		const rect = this.committedCanvas.getBoundingClientRect();

		if (this.eraseZoneSession) {
			const session = this.eraseZoneSession;
			const [docX, docY] = this.eventToXY(event, rect);
			this.eraseZoneAt(this.toPageLocal(session.pageIndex, docX, docY));
			this.finishEraseZone();
			return;
		}

		if (this.eraseStrokeSession) {
			const session = this.eraseStrokeSession;
			const [docX, docY] = this.eventToXY(event, rect);
			this.eraseStrokeAt(this.toPageLocal(session.pageIndex, docX, docY));
			this.finishEraseStroke();
			return;
		}

		if (this.transformSession) {
			const session = this.transformSession;
			const [docX, docY] = this.eventToXY(event, rect);
			const [x, y] = this.toPageLocal(session.pageIndex, docX, docY);
			this.updateTransform([x, y], event.shiftKey);
			this.commitTransform();
			this.activePointerId = null;
			return;
		}

		if (this.activeMarquee) {
			const marquee = this.activeMarquee;
			const [docX, docY] = this.eventToXY(event, rect);
			const [x, y] = this.toPageLocal(marquee.pageIndex, docX, docY);
			this.updateMarquee(x, y);
			if (this.plugin.settings.tool === "capture") {
				this.finishCapture();
			} else {
				this.finishMarquee();
			}
			this.activePointerId = null;
			return;
		}

		if (this.activeShape && this.activeShapePageIndex !== null) {
			const pageIndex = this.activeShapePageIndex;
			const [docX, docY] = this.eventToXY(event, rect);
			const [x, y] = this.toPageLocal(pageIndex, docX, docY);
			this.updateActiveShape([x, y], event.shiftKey);
			this.finishShape();
			this.activePointerId = null;
			return;
		}

		if (this.activeStroke && this.activeStrokePageIndex !== null) {
			const pageIndex = this.activeStrokePageIndex;
			if (this.straightLine) {
				const [docX, docY] = this.eventToXY(event, rect);
				const [ex, ey] = this.toPageLocal(pageIndex, docX, docY);
				this.updateStraightLine(pageIndex, [ex, ey], event.shiftKey, event.altKey, event.pressure);
			} else if (this.recognizedShape) {
				const [docX, docY] = this.eventToXY(event, rect);
				const [ex, ey] = this.toPageLocal(pageIndex, docX, docY);
				this.updateRecognizedShapeScale([ex, ey]);
			} else {
				const [docX, docY] = this.eventToXY(event, rect);
				const [rawX, rawY] = this.toPageLocal(pageIndex, docX, docY);
				this.activeStroke.points.push(this.clampPointToPage(pageIndex, [rawX, rawY, event.pressure]));
			}
			this.finishStroke();
			return;
		}

		this.activePointerId = null;
	};

	private onPointerCancel = (event: PointerEvent): void => {
		this.ignoredPointerIds.delete(event.pointerId);
		this.pointers.delete(event.pointerId);
		this.clearLongPressMenu();

		if (this.viewportGesture) {
			this.maybeEndViewportGesture(event.pointerId);
			return;
		}

		if (event.pointerId !== this.activePointerId) return;

		if (this.eraseZoneSession) {
			this.finishEraseZone();
			return;
		}
		if (this.eraseStrokeSession) {
			this.finishEraseStroke();
			return;
		}

		if (this.transformSession) {
			this.cancelTransform();
			this.activePointerId = null;
			return;
		}

		if (this.activeMarquee) {
			this.activeMarquee = null;
			this.activePointerId = null;
			this.scheduleActiveRedraw();
			return;
		}

		if (this.activeShape) {
			this.activeShape = null;
			this.activeShapePageIndex = null;
			this.activeShapeStart = null;
			this.activePointerId = null;
			this.clearActiveCanvasFull();
			return;
		}

		// Trait interrompu (geste système, perte de contact...) : on ne le garde pas.
		this.activePointerId = null;
		this.activeStroke = null;
		this.activeStrokePageIndex = null;
		this.resetStraightLineState();
		this.clearActiveCanvasFull();
	};

	private onPointerLeave = (event: PointerEvent): void => {
		if (this.activePointerId !== null || this.viewportGesture) return; // pointeur capturé ou geste de vue en cours : le survol continue d'être suivi même hors du canvas

		// Le canvas "quitte" aussi quand le pointeur passe sur un élément
		// d'interface posé par-dessus (bouton de suppression, bouton
		// « Déplacer », bouton d'ajout) : c'est un pointerleave DOM valide,
		// pas un vrai départ du volet. Sans cette exception, ces boutons
		// disparaîtraient dès que le curseur les atteint, empêchant tout clic
		// ou glissement dessus. On utilise elementFromPoint plutôt que
		// event.relatedTarget : entre deux éléments absolument positionnés
		// qui se chevauchent (le canvas et un bouton flottant), relatedTarget
		// s'est révélé pas toujours renseigné de façon fiable — ce qui
		// annulait hoveredPageIndex juste au moment où l'utilisateur
		// atteignait le bouton, le rendant silencieusement inopérant.
		const overEl = document.elementFromPoint(event.clientX, event.clientY);
		if (overEl && this.wrapper?.contains(overEl)) {
			return;
		}

		let changed = false;
		if (this.eraserPreviewPoint) {
			this.eraserPreviewPoint = null;
			this.eraserPreviewPageIndex = null;
			changed = true;
		}
		if (this.hoveredPageIndex !== null) {
			this.hoveredPageIndex = null;
			this.scheduleViewportRedraw();
		}
		if (changed) this.scheduleActiveRedraw();
	};

	/**
	 * Termine le trait : simplifie ses points (Ramer-Douglas-Peucker, voir
	 * simplify.ts — une capture haute fréquence contient beaucoup de points
	 * redondants, quasi alignés), l'enregistre dans l'historique, redessine
	 * le canvas validé depuis le modèle, puis sauvegarde. La simplification
	 * change légèrement la forme (de moins de SIMPLIFY_TOLERANCE px), donc le
	 * dernier trait affiché en direct n'est pas pixel pour pixel identique au
	 * rendu final, mais la différence est sous le seuil visible.
	 */
	private finishStroke(): void {
		const stroke = this.activeStroke;
		const pageIndex = this.activeStrokePageIndex;
		const wasStraightened = this.straightLine !== null;
		const recognized = this.recognizedShape;
		this.activePointerId = null;
		this.activeStroke = null;
		this.activeStrokePageIndex = null;
		this.resetStraightLineState();
		this.clearActiveCanvasFull();
		if (!stroke || pageIndex === null) return;

		if (recognized) {
			// Le tracé au stylo/surligneur d'origine est entièrement remplacé par
			// la forme reconnue : il ne rejoint jamais page.elements lui-même.
			const page = this.pages[pageIndex].page;
			page.elements.push(recognized);
			this.history.push(pageIndex, { type: "addShape", element: recognized });
			this.updateHistoryButtons();
			this.requestSave();
			this.render(pageIndex);

			// Même geste qu'une forme tracée avec la palette (voir finishShape) :
			// passe tout de suite en mode sélection, déjà sélectionnée, pour
			// pouvoir la redimensionner sans changer d'outil — un clic à côté
			// (dans le vide) revient alors seul au stylo, plutôt que de laisser
			// le lasso actif sans qu'on l'ait choisi soi-même. setTool() remet
			// returnToPenAfterDeselect à faux : il faut donc l'armer APRÈS cet
			// appel, jamais avant.
			this.setTool("select");
			this.setSelection(pageIndex, [recognized.id]);
			this.returnToPenAfterDeselect = true;
			this.autoSelectShapeId = recognized.id;
			return;
		}

		// Un segment droit est déjà exactement 2 points (origine, extrémité) :
		// rien à simplifier, et la simplification RDP ne changerait rien à un
		// segment de toute façon (voir simplify.ts, points.length <= 2).
		if (!wasStraightened) {
			stroke.points = simplifyPoints(stroke.points, SIMPLIFY_TOLERANCE);
		}

		const page = this.pages[pageIndex].page;
		page.elements.push(stroke);
		this.history.push(pageIndex, { type: "add", stroke });
		this.updateHistoryButtons();
		this.requestSave();
		this.render(pageIndex);
	}

	// --- Palette de formes prédéfinies -------------------------------------------

	/**
	 * Recalcule entièrement activeShape à partir du point de départ figé
	 * (activeShapeStart) et de la position courante — jamais de façon
	 * incrémentale, comme currentMarqueeShape en mode rectangle. `current`
	 * est ramené aux limites de sa page (comme un trait, voir clampToPage) :
	 * tracer une NOUVELLE forme reste confiné à une page, contrairement à
	 * déplacer une sélection existante, qui peut désormais en changer.
	 *
	 * Maj maintenue : pour rectangle/ellipse, impose un rapport 1:1 (carré,
	 * respectivement cercle) — le côté le plus long des deux axes gagne, en
	 * conservant le signe (donc la direction) de chacun. Pour ligne/flèche,
	 * aimante l'angle par pas de ANGLE_SNAP_STEP_DEG, exactement comme le
	 * stylo en mode ligne droite (voir updateStraightLine).
	 */
	private updateActiveShape(current: [number, number], shiftKey: boolean): void {
		const shape = this.activeShape;
		const start = this.activeShapeStart;
		if (!shape || !start || this.activeShapePageIndex === null) return;
		const page = this.pages[this.activeShapePageIndex].page;

		const [sx, sy] = start;
		const [cx, cy] = this.clampToPage(this.activeShapePageIndex, current[0], current[1]);
		let dx = cx - sx;
		let dy = cy - sy;

		if (shape.shape === "rectangle" || shape.shape === "ellipse" || shape.shape === "triangle") {
			if (shiftKey) {
				// Le rapport 1:1 imposé par Maj ne doit jamais faire ressortir
				// l'axe le plus court au-delà du bord : le côté du carré/cercle
				// est plafonné à la place disponible sur CHAQUE axe dans la
				// direction du glissé, pas seulement au plus grand des deux
				// écarts bruts (qui pouvait dépasser la feuille sur l'axe le
				// plus contraint — voir le bug signalé).
				const maxDX = dx < 0 ? sx : page.width - sx;
				const maxDY = dy < 0 ? sy : page.height - sy;
				const side = Math.min(Math.max(Math.abs(dx), Math.abs(dy)), maxDX, maxDY);
				dx = (dx < 0 ? -1 : 1) * side;
				dy = (dy < 0 ? -1 : 1) * side;
			}
			shape.x = Math.min(sx, sx + dx);
			shape.y = Math.min(sy, sy + dy);
			shape.width = Math.abs(dx);
			shape.height = Math.abs(dy);
		} else {
			if (shiftKey) {
				let dist = Math.hypot(dx, dy);
				if (dist > 0.001) {
					const stepRad = (ANGLE_SNAP_STEP_DEG * Math.PI) / 180;
					const angle = Math.round(Math.atan2(dy, dx) / stepRad) * stepRad;
					const ux = Math.cos(angle);
					const uy = Math.sin(angle);
					// Aimanter l'angle change la direction sans changer la
					// distance parcourue : cette nouvelle direction peut viser
					// hors de la page alors que le glissé brut, lui, y restait
					// (déjà ramené dans ses limites ci-dessus) — la distance est
					// donc à son tour plafonnée à ce que CETTE direction précise
					// permet avant de sortir.
					dist = Math.min(dist, Math.max(0, this.maxDistAlongDirection(sx, sy, ux, uy, page)));
					dx = ux * dist;
					dy = uy * dist;
				}
			}
			shape.x = sx;
			shape.y = sy;
			shape.width = dx;
			shape.height = dy;
		}
	}

	/** Plus grande distance parcourable depuis (sx, sy) le long de la direction unitaire (ux, uy) sans quitter `page` — utilisé par updateActiveShape pour plafonner une ligne/flèche après aimantation de son angle (Maj), qui peut sinon viser hors de la page malgré un glissé resté dans ses limites. */
	private maxDistAlongDirection(sx: number, sy: number, ux: number, uy: number, page: DrawingPage): number {
		const maxAlongAxis = (s: number, u: number, limit: number): number => {
			if (Math.abs(u) < 1e-9) return Infinity;
			const boundValue = u > 0 ? limit - s : -s;
			return boundValue / u;
		};
		return Math.min(maxAlongAxis(sx, ux, page.width), maxAlongAxis(sy, uy, page.height));
	}

	/**
	 * Termine le tracé d'une forme : un simple clic sans glissement (ni
	 * largeur ni hauteur perceptible) ne produit rien, comme un clic à vide
	 * avec le lasso — une forme d'un pixel n'a aucun intérêt à garder.
	 */
	private finishShape(): void {
		const shape = this.activeShape;
		const pageIndex = this.activeShapePageIndex;
		this.activeShape = null;
		this.activeShapePageIndex = null;
		this.activeShapeStart = null;
		this.clearActiveCanvasFull();
		if (!shape || pageIndex === null) return;
		if (Math.abs(shape.width) < 2 && Math.abs(shape.height) < 2) return;

		const page = this.pages[pageIndex].page;
		page.elements.push(shape);
		this.history.push(pageIndex, { type: "addShape", element: shape });
		this.updateHistoryButtons();
		this.requestSave();
		this.render(pageIndex);

		// Une forme fraîchement tracée passe tout de suite en mode sélection,
		// déjà sélectionnée : le geste naturel juste après un rectangle/rond/
		// triangle/flèche est presque toujours de le repositionner ou le
		// redimensionner, pas d'en tracer un autre immédiatement (voir le bug
		// signalé). setTool() remet returnToPenAfterDeselect à faux : il faut
		// donc l'armer APRÈS cet appel, jamais avant.
		this.setTool("select");
		this.setSelection(pageIndex, [shape.id]);
		this.returnToPenAfterDeselect = true;
		this.autoSelectShapeId = shape.id;
	}

	// --- Gomme par zone ------------------------------------------------------------

	/**
	 * Insère des points intermédiaires le long de tout segment plus long que
	 * ERASE_SAMPLE_STEP_PX — sans effet sur un trait déjà dense (le cas normal
	 * d'un tracé à main levée, où deux points consécutifs sont toujours très
	 * rapprochés). Nécessaire avant de passer un trait à render.ts:eraseZone :
	 * un trait devenu une ligne droite par maintien (voir updateStraightLine)
	 * n'a plus que 2 points, donc un seul segment très long — sans cette
	 * densification, le moindre contact l'effaçait EN ENTIER, quel que soit
	 * le rayon de la gomme, puisque eraseZone marque un point PAR SEGMENT,
	 * jamais une portion de segment. Renvoie `points` tel quel (même
	 * référence) si rien n'a dû être inséré, pour que l'appelant puisse éviter
	 * une copie inutile de l'élément.
	 */
	private densifyForEraser(points: Pt[]): Pt[] {
		if (points.length < 2) return points;
		let needsDensify = false;
		for (let i = 1; i < points.length && !needsDensify; i++) {
			const dx = points[i][0] - points[i - 1][0];
			const dy = points[i][1] - points[i - 1][1];
			if (Math.hypot(dx, dy) > ERASE_SAMPLE_STEP_PX) needsDensify = true;
		}
		if (!needsDensify) return points;

		const dense: Pt[] = [points[0]];
		for (let i = 1; i < points.length; i++) {
			const [ax, ay, ap] = points[i - 1];
			const [bx, by, bp] = points[i];
			const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / ERASE_SAMPLE_STEP_PX));
			for (let s = 1; s <= steps; s++) {
				const t = s / steps;
				dense.push([ax + (bx - ax) * t, ay + (by - ay) * t, ap + (bp - ap) * t]);
			}
		}
		return dense;
	}

	/** Échantillonne le pourtour d'un polygone (coins en repère LOCAL, avant rotation) à intervalle constant (voir ERASE_SAMPLE_STEP_PX), en refermant la boucle sur le premier coin — factorisé entre rectangle et triangle (voir shapeOutlinePoints), seuls leurs coins diffèrent. */
	private samplePolygonOutline(corners: [number, number][], toPage: (lx: number, ly: number) => Pt): Pt[] {
		const closed = [...corners, corners[0]];
		const points: Pt[] = [];
		for (let e = 0; e < corners.length; e++) {
			const [ax, ay] = closed[e];
			const [bx, by] = closed[e + 1];
			const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / ERASE_SAMPLE_STEP_PX));
			for (let s = 0; s < steps; s++) {
				const t = s / steps;
				points.push(toPage(ax + (bx - ax) * t, ay + (by - ay) * t));
			}
		}
		const last = closed[closed.length - 1];
		points.push(toPage(last[0], last[1])); // referme la boucle
		return points;
	}

	/**
	 * Points d'échantillonnage du CONTOUR d'un rectangle/triangle/ellipse, en
	 * repère de page (rotation déjà appliquée) — jamais pour ligne/flèche
	 * (voir eraseLineZone, un vrai segment, pas un contour à échantillonner).
	 * Rectangle/triangle : leurs coins, échantillonnés à intervalle constant
	 * (voir samplePolygonOutline). Ellipse : approximée par un polygone dont
	 * le nombre de côtés suit son périmètre (voir ERASE_SAMPLE_STEP_PX) — fin
	 * par construction (voir eraseZone, render.ts, qui opère point par
	 * point), donc un rendu visuellement lisse même sur une grande ellipse.
	 */
	private shapeOutlinePoints(el: ShapeElement): Pt[] {
		const cx = el.x + el.width / 2;
		const cy = el.y + el.height / 2;
		const toPage = (lx: number, ly: number): Pt => {
			const r = rotatePointAround(lx, ly, cx, cy, el.rotation);
			return [r.x, r.y, 0.5];
		};

		// eraseZone (render.ts) marque ou épargne un point PAR SEGMENT entier,
		// jamais une portion de segment : avec seulement les coins d'un
		// rectangle/triangle (un segment par côté), toucher NE SERAIT-CE QU'UN
		// POINT d'un côté en effaçait le côté ENTIER, quel que soit le rayon
		// de la gomme. L'échantillonnage vise donc un espacement constant
		// (ERASE_SAMPLE_STEP_PX), pas un nombre de points fixe : une petite
		// forme et une grande ont toutes deux une granularité fine par
		// rapport à leur propre taille.
		if (el.shape === "rectangle") {
			return this.samplePolygonOutline(
				[
					[el.x, el.y],
					[el.x + el.width, el.y],
					[el.x + el.width, el.y + el.height],
					[el.x, el.y + el.height],
				],
				toPage
			);
		}
		if (el.shape === "triangle") {
			// Mêmes trois sommets que le rendu (voir drawShapeElement,
			// render.ts) : isocèle, sommet en haut au centre.
			return this.samplePolygonOutline(
				[
					[el.x + el.width / 2, el.y],
					[el.x + el.width, el.y + el.height],
					[el.x, el.y + el.height],
				],
				toPage
			);
		}

		const rx = Math.abs(el.width) / 2;
		const ry = Math.abs(el.height) / 2;
		// Approximation de Ramanujan du périmètre d'une ellipse — suffisante
		// ici, elle ne sert qu'à choisir un nombre d'échantillons raisonnable.
		const perimeter = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
		const samples = Math.max(24, Math.round(perimeter / ERASE_SAMPLE_STEP_PX));
		const points: Pt[] = [];
		for (let i = 0; i <= samples; i++) {
			const a = (i / samples) * Math.PI * 2;
			points.push(toPage(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry));
		}
		return points;
	}

	/**
	 * Gomme par zone sur un rectangle/ellipse : son contour (voir
	 * shapeOutlinePoints) est traité EXACTEMENT comme le trait d'un stylo — un
	 * élément "trait" fictif, jamais persisté tel quel — et réutilise
	 * render.ts:strokeHitTest/eraseZone tels quels, MÊME pré-filtre qu'un vrai
	 * trait (`null` si la gomme ne touche pas réellement le contour) : sans ce
	 * test, un passage n'importe où dans l'INTÉRIEUR de la forme (loin de son
	 * contour, jamais rempli — voir ShapeElement) la remplacerait à tort par
	 * une copie conforme sous forme de trait, alors que rien n'a été effacé.
	 * Une forme partiellement effacée n'est plus un rectangle ou une ellipse
	 * propre (un contour entamé n'a pas de forme géométrique simple) : ce qui
	 * survit devient donc des TRAITS ordinaires, pas des fragments de la
	 * forme d'origine — cohérent avec le fait qu'on dessine ensuite dessus
	 * comme sur n'importe quel trait.
	 */
	private eraseShapeOutlineZone(el: ShapeElement, cx: number, cy: number, radius: number): StrokeElement[] | null {
		const outline = this.shapeOutlinePoints(el);
		const virtualStroke: Stroke = { id: el.id, tool: "pen", color: el.color, size: el.size, points: outline };
		if (!strokeHitTest(virtualStroke, [cx, cy], radius)) return null;

		const fragments = eraseZone(virtualStroke, cx, cy, radius);

		// Le contour est une boucle FERMÉE (son premier et son dernier point
		// sont confondus, voir shapeOutlinePoints) mais eraseZone (render.ts)
		// traite tout trait comme un chemin OUVERT, sans jamais relier son
		// dernier point au premier : si les deux extrémités du tableau
		// survivent chacune dans un fragment distinct, elles forment en
		// réalité un seul morceau continu à travers cette « couture »
		// artificielle — sans cette fusion, une zone effacée qui chevauche la
		// couture séparerait à tort un seul bout continu en deux fragments
		// distincts.
		if (fragments.length >= 2) {
			const first = fragments[0];
			const last = fragments[fragments.length - 1];
			const firstPt = first.points[0];
			const originPt = outline[0];
			const lastPt = last.points[last.points.length - 1];
			const closingPt = outline[outline.length - 1];
			const startsAtOrigin = firstPt[0] === originPt[0] && firstPt[1] === originPt[1];
			const endsAtClosing = lastPt[0] === closingPt[0] && lastPt[1] === closingPt[1];
			if (startsAtOrigin && endsAtClosing) {
				const merged: StrokeElement = { ...last, points: [...last.points, ...first.points.slice(1)] };
				return [merged, ...fragments.slice(1, -1)];
			}
		}
		return fragments;
	}

	/**
	 * Gomme par zone sur une ligne/flèche : contrairement à un trait à
	 * plusieurs points, un segment à seulement 2 extrémités n'a pas de point
	 * intermédiaire à marquer effacé un par un (voir render.ts:eraseZone,
	 * conçu pour un trait) — on calcule ici directement l'intersection
	 * cercle/segment (équation quadratique standard) pour trouver la portion
	 * [t0, t1] du segment tombée dans le rayon de la gomme, et on ne garde que
	 * ce qui reste avant t0 et après t1, chacun comme une nouvelle ligne/
	 * flèche. Le fragment qui inclut encore l'extrémité d'origine (t=1) garde
	 * le type de `el` (line/arrow) ; l'autre — qui a perdu la pointe —
	 * redevient une simple ligne, une flèche sans pointe n'ayant pas de sens.
	 */
	private eraseLineZone(el: ShapeElement, ex: number, ey: number, radius: number): ShapeElement[] {
		const cx = el.x + el.width / 2;
		const cy = el.y + el.height / 2;
		const p0 = rotatePointAround(el.x, el.y, cx, cy, el.rotation);
		const p1 = rotatePointAround(el.x + el.width, el.y + el.height, cx, cy, el.rotation);

		// Rayon effectif identique à celui du pré-filtre (voir
		// eraserTouchesLine, appelé par l'appelant avant celle-ci) : sans ce
		// "+ size/2", un contact confirmé par le pré-filtre pouvait ne
		// correspondre à AUCUNE intersection réelle ici (rayon plus petit,
		// discriminant parfois négatif) — et tombait alors dans le repli
		// ci-dessous, qui supprimait tout le trait au lieu d'un bout : c'était
		// le vrai bug signalé ("parfois ça supprime tout d'un coup").
		const effectiveRadius = radius + el.size / 2;
		const dx = p1.x - p0.x;
		const dy = p1.y - p0.y;
		const fx = p0.x - ex;
		const fy = p0.y - ey;
		const a = dx * dx + dy * dy;
		const b = 2 * (fx * dx + fy * dy);
		const c = fx * fx + fy * fy - effectiveRadius * effectiveRadius;
		const disc = b * b - 4 * a * c;

		if (a < 1e-9) return []; // segment quasi ponctuel : rien à découper, aucune "portion" n'a de sens

		let t0: number;
		let t1: number;
		if (disc < 0) {
			// Cas limite d'arrondi flottant uniquement (le pré-filtre garantit
			// qu'un point du segment est à portée) : n'efface qu'au point le
			// plus proche, jamais le trait entier.
			const tClosest = clamp(-b / (2 * a), 0, 1);
			t0 = tClosest;
			t1 = tClosest;
		} else {
			const sq = Math.sqrt(disc);
			t0 = clamp((-b - sq) / (2 * a), 0, 1);
			t1 = clamp((-b + sq) / (2 * a), 0, 1);
		}

		const MIN_FRAGMENT_LEN = 4; // pixels logiques, comme le seuil de taille minimale à la création (voir finishShape)
		const fragments: ShapeElement[] = [];
		const addFragment = (ta: number, tb: number, keepsOriginalKind: boolean): void => {
			const fx0 = p0.x + ta * dx;
			const fy0 = p0.y + ta * dy;
			const fx1 = p0.x + tb * dx;
			const fy1 = p0.y + tb * dy;
			if (Math.hypot(fx1 - fx0, fy1 - fy0) < MIN_FRAGMENT_LEN) return;
			fragments.push({
				id: newStrokeId(),
				type: "shape",
				shape: keepsOriginalKind ? el.shape : "line",
				x: fx0,
				y: fy0,
				width: fx1 - fx0,
				height: fy1 - fy0,
				rotation: 0,
				color: el.color,
				size: el.size,
			});
		};

		if (t0 > 0) addFragment(0, t0, false);
		if (t1 < 1) addFragment(t1, 1, true);
		return fragments;
	}

	/**
	 * Remplace chaque trait touché par ses fragments survivants (voir
	 * render.ts:eraseZone), sur la page de la session en cours. La détection
	 * (et la mise à jour du modèle) a lieu à chaque événement pointeur, sans
	 * throttling : c'est bon marché, la boîte englobante de chaque trait est
	 * mise en cache (render.ts:strokeBounds) et écarte la plupart des traits
	 * avant tout calcul détaillé. Le redessin visuel, lui, est throttled à une
	 * fois par frame ET limité à la zone touchée (scheduleCommittedRedraw +
	 * markErasedRegion) : la gomme modifie le modèle en continu, régénérer
	 * tout le cache de la page à chaque frame serait le vrai coût. L'action
	 * d'historique n'est enregistrée qu'à la fin du geste (voir
	 * finishEraseZone), sinon un appui prolongé produirait une entrée par frame.
	 */
	private eraseZoneAt(point: [number, number]): void {
		const session = this.eraseZoneSession;
		if (!session) return;
		const page = this.pages[session.pageIndex].page;
		const [cx, cy] = point;
		const radius = this.eraserRadius;
		let changed = false;

		for (let i = page.elements.length - 1; i >= 0; i--) {
			const el = page.elements[i];
			let bounds: StrokeBounds;
			let pad: number;
			let fragments: DrawElement[];

			if (el.type === "stroke") {
				bounds = strokeBounds(el);
				if (!boundsNearCircle(bounds, cx, cy, radius)) continue;
				if (!strokeHitTest(el, point, radius)) continue;
				pad = el.size;
				// eraseZone (render.ts) marque un point PAR SEGMENT entier,
				// jamais une portion de segment (voir shapeOutlinePoints, même
				// souci pour une forme) : un trait devenu une ligne droite par
				// maintien n'a plus que 2 points (voir updateStraightLine),
				// donc un seul segment — le moindre contact l'effaçait en
				// entier, quel que soit le rayon de la gomme. densifyForEraser
				// n'a aucun effet sur un trait déjà dense (le cas normal d'un
				// tracé à main levée).
				const dense = this.densifyForEraser(el.points);
				fragments = eraseZone(dense === el.points ? el : { ...el, points: dense }, cx, cy, radius);
			} else if (el.type === "shape" && (el.shape === "line" || el.shape === "arrow")) {
				bounds = computeElementBounds(el);
				if (!boundsNearCircle(bounds, cx, cy, radius)) continue;
				if (!this.eraserTouchesLine(el, cx, cy, radius)) continue;
				pad = el.size;
				fragments = this.eraseLineZone(el, cx, cy, radius);
			} else if (el.type === "shape") {
				bounds = computeElementBounds(el);
				if (!boundsNearCircle(bounds, cx, cy, radius)) continue;
				const outlineFragments = this.eraseShapeOutlineZone(el, cx, cy, radius);
				if (!outlineFragments) continue; // gomme dans l'intérieur vide, jamais sur le contour : rien à faire (voir eraseShapeOutlineZone)
				pad = el.size;
				fragments = outlineFragments;
			} else {
				continue; // image : jamais touchée par la gomme
			}

			this.markErasedRegion(session.pageIndex, bounds, pad);
			page.elements.splice(i, 1, ...fragments);

			if (session.originalSnapshot.has(el.id)) {
				session.touchedOriginalIds.add(el.id);
			} else {
				session.liveFragmentIds.delete(el.id);
			}
			for (const frag of fragments) session.liveFragmentIds.add(frag.id);

			changed = true;
		}

		if (changed) this.scheduleCommittedRedraw(session.pageIndex);
	}

	/** Fin du geste : un seul redessin complet du cache de la page (voir render()), et une seule entrée d'historique quelle que soit la durée du geste. */
	private finishEraseZone(): void {
		this.activePointerId = null;
		const session = this.eraseZoneSession;
		this.eraseZoneSession = null;
		if (!session) return;
		this.cancelScheduledCommittedRedraw(session.pageIndex);
		if (session.touchedOriginalIds.size === 0) return;

		const page = this.pages[session.pageIndex].page;
		const removed = [...session.touchedOriginalIds].map((id) => session.originalSnapshot.get(id)!);
		const added = page.elements.filter((el) => session.liveFragmentIds.has(el.id));
		this.history.push(session.pageIndex, { type: "erase", removed, added });
		this.updateHistoryButtons();
		this.requestSave();
		this.render(session.pageIndex);
	}

	// --- Gomme par trait entier ------------------------------------------------------

	/** Vrai si le cercle de gomme (centre + rayon) touche le rectangle (éventuellement pivoté) de `el` — image, ou forme "rectangle"/"ellipse" (width/height toujours positifs pour ces deux-là, voir ShapeElement) — en ramenant le centre dans le repère local (voir hitTestElementAt) puis en cherchant le point du rectangle le plus proche de ce centre, comme un test cercle/AABB classique. Jamais pour "line"/"arrow" (voir eraserTouchesLine) : leur width/height signé casserait ce test, qui suppose min <= max. */
	private eraserTouchesBox(el: ImageElement | ShapeElement, cx: number, cy: number, radius: number): boolean {
		const local = rotatePointAround(cx, cy, el.x + el.width / 2, el.y + el.height / 2, -el.rotation);
		const closestX = clamp(local.x, el.x, el.x + el.width);
		const closestY = clamp(local.y, el.y, el.y + el.height);
		const dx = local.x - closestX;
		const dy = local.y - closestY;
		return dx * dx + dy * dy <= radius * radius;
	}

	/** Comme eraserTouchesBox, mais pour "line"/"arrow" : pas de surface à tester, seulement la distance au segment lui-même (voir distanceToSegment, render.ts) — le même test que hitTestElementAt utilise pour la sélection. */
	private eraserTouchesLine(el: ShapeElement, cx: number, cy: number, radius: number): boolean {
		const local = rotatePointAround(cx, cy, el.x + el.width / 2, el.y + el.height / 2, -el.rotation);
		const dist = distanceToSegment([local.x - el.x, local.y - el.y], [0, 0], [el.width, el.height]);
		return dist <= radius + el.size / 2;
	}

	private eraseStrokeAt(point: [number, number]): void {
		const session = this.eraseStrokeSession;
		if (!session) return;
		const page = this.pages[session.pageIndex].page;
		const radius = this.eraserRadius;
		let changed = false;

		for (let i = page.elements.length - 1; i >= 0; i--) {
			const el = page.elements[i];
			// Une forme (voir ShapeElement, model.ts) n'a pas de champ `locked` :
			// jamais verrouillable, donc jamais protégée par ce garde-fou —
			// rien à vérifier pour elle ici.
			if (el.type !== "shape" && el.locked) continue;
			let bounds: StrokeBounds;
			let pad = 0;
			if (el.type === "stroke") {
				bounds = strokeBounds(el);
				if (!boundsNearCircle(bounds, point[0], point[1], radius)) continue;
				if (!strokeHitTest(el, point, radius)) continue;
				pad = el.size;
			} else if (el.type === "shape" && (el.shape === "line" || el.shape === "arrow")) {
				bounds = computeElementBounds(el);
				if (!this.eraserTouchesLine(el, point[0], point[1], radius)) continue;
				pad = el.size;
			} else {
				bounds = computeElementBounds(el);
				if (!this.eraserTouchesBox(el, point[0], point[1], radius)) continue;
				if (el.type === "shape") pad = el.size;
			}

			this.markErasedRegion(session.pageIndex, bounds, pad);

			const index = session.originalIndex.get(el.id) ?? i;
			session.removed.push({ index, element: el });
			page.elements.splice(i, 1);
			changed = true;
		}

		if (changed) this.scheduleCommittedRedraw(session.pageIndex);
	}

	/** Fin du geste : un seul redessin complet du cache de la page, et une seule entrée d'historique quelle que soit la durée du geste. */
	private finishEraseStroke(): void {
		this.activePointerId = null;
		const session = this.eraseStrokeSession;
		this.eraseStrokeSession = null;
		if (!session) return;
		this.cancelScheduledCommittedRedraw(session.pageIndex);
		if (session.removed.length === 0) return;

		this.history.push(session.pageIndex, { type: "remove", removed: session.removed });
		this.updateHistoryButtons();
		this.requestSave();
		this.render(session.pageIndex);
	}

	// --- Outil sélection ----------------------------------------------------------

	/**
	 * Poignée de la sélection existante > intérieur du cadre (déplacement) >
	 * élément touché directement (sélection, puis déplacement dans le même
	 * geste) > zone vide (nouveau lasso/rectangle, seulement si `allowMarquee`).
	 * Le clic droit n'entre jamais ici : il est déjà écarté avant l'appel (voir
	 * onPointerDown). Partagé par les outils lasso et curseur (voir
	 * isSelectionTool) : tout leur comportement est identique, à une seule
	 * différence près — `allowMarquee` (faux pour le curseur) — plutôt que
	 * deux copies de cette logique. `pageIndex`/`x`/`y` : la page où le clic
	 * est tombé (déjà résolue par onPointerDown) et sa position dans le
	 * repère de CETTE page.
	 */
	private onSelectPointerDown(event: PointerEvent, pageIndex: number, x: number, y: number, allowMarquee: boolean): void {
		// Une poignée ou le cadre d'une sélection existante n'ont de sens que
		// si le clic tombe sur la MÊME page que cette sélection : sur une autre
		// page, rien de tout ça ne s'applique, c'est un tout nouveau clic.
		const sameSelectionPage = this.selectedPageIndex === pageIndex;
		const bounds = sameSelectionPage ? this.selectionBounds() : null;

		if (bounds && this.isSelectionTransformable()) {
			// Coordonnées écran relatives au canvas (comme pageToScreen, dont
			// dérive selectionHandlePositions) : comparer directement à
			// event.clientX/clientY (relatifs à la fenêtre) ferait manquer
			// systématiquement toutes les poignées dès que le canvas n'est pas
			// collé au coin de la fenêtre — ce qui est le cas en pratique dès que
			// la barre d'outils ou un panneau Obsidian décale le canvas.
			const rect = this.committedCanvas.getBoundingClientRect();
			const handle = this.hitTestSelectionHandle(pageIndex, event.clientX - rect.left, event.clientY - rect.top, bounds);
			if (handle === "rotate") {
				this.startTransform(pageIndex, "rotate", [x, y]);
				return;
			}
			if (handle) {
				this.startTransform(pageIndex, "resize", [x, y], handle);
				return;
			}
			if (pointInRect(x, y, bounds)) {
				this.startTransform(pageIndex, "move", [x, y]);
				return;
			}
		}

		// Avec le lasso (allowMarquee), un élément verrouillé touché ne compte
		// jamais comme un "hit" : sinon, un grand élément verrouillé (une image
		// de fond, typiquement) intercepterait tout clic tombant dans sa boîte
		// englobante — même visuellement vide — et empêcherait à la fois de
		// tracer un nouveau lasso par-dessus et de cliquer à côté pour
		// désélectionner (voir la branche "zone vide" plus bas et
		// returnToPenAfterDeselect, qui ne se déclencherait alors plus jamais).
		// Le curseur, qui ne trace jamais de lasso, garde lui l'ancien
		// comportement : cliquer directement sur un élément verrouillé reste le
		// seul geste pour le sélectionner (et le déverrouiller) — voir
		// finishMarquee, qui exclut déjà ces éléments d'un entourage.
		let hit = this.hitTestElementAt(pageIndex, x, y);
		if (hit && allowMarquee && hit.type !== "shape" && hit.locked) hit = null;
		if (hit) {
			// Un clic qui touche un élément AUTRE que celui qui a armé la grâce
			// (voir returnToPenAfterDeselect) l'annule sans la déclencher : on
			// considère alors l'outil sélection utilisé intentionnellement pour
			// autre chose. Recliquer sur CE MÊME élément (le redimensionner via
			// une poignée, le redéplacer, le resélectionner) la laisse au
			// contraire armée — voir plus bas, la branche "zone vide".
			if (this.returnToPenAfterDeselect && hit.id !== this.autoSelectShapeId) {
				this.returnToPenAfterDeselect = false;
				this.autoSelectShapeId = null;
			}
			if (event.shiftKey && sameSelectionPage) {
				const next = new Set(this.selectedIds);
				if (next.has(hit.id)) next.delete(hit.id);
				else next.add(hit.id);
				this.setSelection(pageIndex, next);
			} else if (!sameSelectionPage || !this.selectedIds.has(hit.id)) {
				this.setSelection(pageIndex, [hit.id]);
			}
			if (this.selectedIds.has(hit.id) && this.isSelectionTransformable()) this.startTransform(pageIndex, "move", [x, y]);
			return;
		}

		// Zone vide : le curseur désélectionne simplement, sans tracer de zone
		// (voir la fonctionnalité "outil curseur") — seul le lasso entoure.
		this.clearSelection();

		// Clic à côté alors que la grâce est encore armée (voir
		// returnToPenAfterDeselect — restée armée tant qu'on n'a fait
		// qu'interagir avec la forme qui l'a créée, voir la branche "hit"
		// ci-dessus) : on ne cherche jamais à ouvrir un lasso ici, l'outil
		// revient directement au stylo.
		if (this.returnToPenAfterDeselect) {
			this.setTool("pen");
			return;
		}

		if (allowMarquee) this.startMarquee(pageIndex, x, y, event.shiftKey);
	}

	/** Faux dès qu'un élément verrouillé fait partie de la sélection courante : déplacement, redimensionnement et rotation s'appliquent à toute la sélection d'un bloc (voir TransformSession), il n'existe pas de transformation "partielle" qui épargnerait le seul élément verrouillé. */
	private isSelectionTransformable(): boolean {
		if (this.selectedPageIndex === null) return true;
		const page = this.pages[this.selectedPageIndex].page;
		for (const el of page.elements) {
			if (el.type !== "shape" && this.selectedIds.has(el.id) && el.locked) return false;
		}
		return true;
	}

	/** Vrai seulement si la sélection contient au moins une image et que chacune de ses images est verrouillée — les traits, jamais verrouillables, n'entrent pas en compte. Sert à décider si le bouton verrou de la barre d'outils verrouille ou déverrouille au prochain clic (voir toggleSelectionLock). */
	private isSelectionFullyLocked(): boolean {
		if (this.selectedPageIndex === null) return false;
		const page = this.pages[this.selectedPageIndex].page;
		let hasImage = false;
		for (const el of page.elements) {
			if (!this.selectedIds.has(el.id) || el.type !== "image") continue;
			hasImage = true;
			if (!el.locked) return false;
		}
		return hasImage;
	}

	/** Élément touché sous (x, y), repère de `pageIndex` — parcouru en ordre inverse (dernier dessiné = premier testé, comme il apparaît visuellement au-dessus). */
	private hitTestElementAt(pageIndex: number, x: number, y: number): DrawElement | null {
		const rt = this.pages[pageIndex];
		if (!rt) return null;
		const elements = rt.page.elements;
		for (let i = elements.length - 1; i >= 0; i--) {
			const el = elements[i];
			if (el.type === "stroke") {
				const bounds = strokeBounds(el);
				const tolerance = SELECT_HIT_TOLERANCE_PX + el.size / 2;
				if (!boundsNearCircle(bounds, x, y, tolerance)) continue;
				if (strokeHitTest(el, [x, y], tolerance)) return el;
			} else if (el.type === "shape" && (el.shape === "line" || el.shape === "arrow")) {
				// Une ligne/flèche n'a pas de surface propre (contrairement à un
				// rectangle) : on teste la distance au SEGMENT lui-même, dans son
				// repère local (voir eraserTouchesLine, le même test pour la
				// gomme) — jamais "n'importe où dans sa boîte englobante", qui
				// serait souvent bien plus grande que le trait visible.
				const cx = el.x + el.width / 2;
				const cy = el.y + el.height / 2;
				const local = rotatePointAround(x, y, cx, cy, -el.rotation);
				const tolerance = SELECT_HIT_TOLERANCE_PX + el.size / 2;
				const dist = distanceToSegment([local.x - el.x, local.y - el.y], [0, 0], [el.width, el.height]);
				if (dist <= tolerance) return el;
			} else {
				// Image, ou forme "rectangle"/"ellipse" (width/height toujours
				// positifs pour ces deux-là, voir ShapeElement) : n'importe où
				// dans le rectangle englobant sélectionne l'élément, comme pour
				// une image — pas un contour précis, une simplification déjà
				// acceptée pour les images.
				const local = rotatePointAround(x, y, el.x + el.width / 2, el.y + el.height / 2, -el.rotation);
				if (pointInRect(local.x, local.y, { minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + el.height })) {
					return el;
				}
			}
		}
		return null;
	}

	private static unionBounds(elements: DrawElement[]): StrokeBounds | null {
		let bounds: StrokeBounds | null = null;
		for (const el of elements) {
			const b = computeElementBounds(el);
			bounds = bounds
				? {
						minX: Math.min(bounds.minX, b.minX),
						minY: Math.min(bounds.minY, b.minY),
						maxX: Math.max(bounds.maxX, b.maxX),
						maxY: Math.max(bounds.maxY, b.maxY),
				  }
				: b;
		}
		return bounds;
	}

	/** Boîte englobante de la sélection courante (union de chaque élément sélectionné, tous sur `selectedPageIndex`), ou null si rien n'est sélectionné ou si les ids ne correspondent plus à rien (élément entre-temps supprimé par un undo externe, par exemple). */
	private selectionBounds(): StrokeBounds | null {
		if (this.selectedPageIndex === null) return null;
		const page = this.pages[this.selectedPageIndex].page;
		return DrawView.unionBounds(page.elements.filter((el) => this.selectedIds.has(el.id)));
	}

	/** Positions écran (client) de chaque poignée d'une sélection sur `pageIndex`, calculées depuis sa boîte englobante logique — c'est en écran qu'on veut une tolérance de préhension constante, indépendante du zoom. */
	private selectionHandlePositions(pageIndex: number, bounds: StrokeBounds): Record<SelectionHandle, [number, number]> {
		const corner = (hx: -1 | 0 | 1, hy: -1 | 0 | 1): [number, number] => {
			const lx = hx === -1 ? bounds.minX : hx === 1 ? bounds.maxX : (bounds.minX + bounds.maxX) / 2;
			const ly = hy === -1 ? bounds.minY : hy === 1 ? bounds.maxY : (bounds.minY + bounds.maxY) / 2;
			return this.pageToScreen(pageIndex, lx, ly);
		};
		const positions = {} as Record<SelectionHandle, [number, number]>;
		for (const handle of RESIZE_HANDLES) {
			const axes = HANDLE_AXES[handle];
			positions[handle] = corner(axes.x, axes.y);
		}
		const [topX, topY] = corner(0, -1);
		positions.rotate = [topX, topY - ROTATE_HANDLE_OFFSET_PX];
		return positions;
	}

	/** screenX/screenY : coordonnées écran relatives au canvas (mêmes repère que selectionHandlePositions/pageToScreen) — jamais event.clientX/clientY bruts, voir onSelectPointerDown. */
	private hitTestSelectionHandle(pageIndex: number, screenX: number, screenY: number, bounds: StrokeBounds): SelectionHandle | null {
		const positions = this.selectionHandlePositions(pageIndex, bounds);
		for (const handle of [...RESIZE_HANDLES, "rotate" as const]) {
			const [hx, hy] = positions[handle];
			if (Math.hypot(screenX - hx, screenY - hy) <= HANDLE_GRAB_RADIUS_PX) return handle;
		}
		return null;
	}

	/** Clonage profond (pas une simple copie de référence) : les transformations ne doivent jamais muter l'objet d'origine, ni le clone du "before" d'une action d'historique — voir le commentaire sur l'immutabilité des traits dans render.ts:strokeBounds. */
	private cloneElement(el: DrawElement): DrawElement {
		return el.type === "stroke" ? { ...el, points: el.points.map((p) => [...p] as Pt) } : { ...el };
	}

	private setSelection(pageIndex: number, ids: Iterable<string>): void {
		this.selectedIds = new Set(ids);
		this.selectedPageIndex = this.selectedIds.size > 0 ? pageIndex : null;
		this.updateSelectionActionsToolbar();
		this.scheduleActiveRedraw();
	}

	private clearSelection(): void {
		if (this.selectedIds.size === 0) return;
		this.selectedIds.clear();
		this.selectedPageIndex = null;
		this.updateSelectionActionsToolbar();
		this.scheduleActiveRedraw();
	}

	// --- Marquee (lasso / rectangle) ---------------------------------------------

	private startMarquee(pageIndex: number, x: number, y: number, rectMode: boolean): void {
		this.activeMarquee = { pageIndex, mode: rectMode ? "rect" : "lasso", points: [{ x, y }] };
		this.startMarqueeAnimation();
	}

	private updateMarquee(x: number, y: number): void {
		if (!this.activeMarquee) return;
		if (this.activeMarquee.mode === "rect") {
			this.activeMarquee.points = [this.activeMarquee.points[0], { x, y }];
		} else {
			this.activeMarquee.points.push({ x, y });
		}
		this.scheduleActiveRedraw();
	}

	private currentMarqueeShape(): Marquee | null {
		if (!this.activeMarquee) return null;
		if (this.activeMarquee.mode === "rect") {
			const [a, b] = this.activeMarquee.points;
			const other = b ?? a;
			return {
				mode: "rect",
				bounds: {
					minX: Math.min(a.x, other.x),
					minY: Math.min(a.y, other.y),
					maxX: Math.max(a.x, other.x),
					maxY: Math.max(a.y, other.y),
				},
			};
		}
		return { mode: "lasso", points: this.activeMarquee.points };
	}

	/** Anime les pointillés du lasso/rectangle indépendamment des événements pointeur, comme le halo de conversion en ligne droite (voir startStraightenFlash). */
	private startMarqueeAnimation(): void {
		let last = performance.now();
		const tick = (now: number): void => {
			if (!this.activeMarquee) {
				this.marqueeAnimHandle = null;
				return;
			}
			const dt = (now - last) / 1000;
			last = now;
			this.marqueeDashOffset -= MARQUEE_DASH_SPEED_PX_PER_S * dt;
			this.scheduleActiveRedraw();
			this.marqueeAnimHandle = window.requestAnimationFrame(tick);
		};
		this.marqueeAnimHandle = window.requestAnimationFrame(tick);
	}

	/**
	 * Filtre d'abord par boîte englobante avant tout test point par point,
	 * comme pour la gomme (voir eraseZoneAt). Remplace toujours la sélection :
	 * Maj ne fait que choisir la forme du geste (voir startMarquee), pas
	 * l'ajout à une sélection existante. Ne teste jamais que les éléments de
	 * `marquee.pageIndex` : un lasso qui déborde visuellement sur la page
	 * suivante ne peut de toute façon pas sélectionner ce qui appartient à un
	 * autre tableau d'éléments.
	 */
	private finishMarquee(): void {
		const marquee = this.currentMarqueeShape();
		const pageIndex = this.activeMarquee?.pageIndex ?? null;
		this.activeMarquee = null;
		if (!marquee || pageIndex === null) return;
		const rt = this.pages[pageIndex];
		if (!rt) return;

		const marqueeBox = marquee.mode === "rect" ? marquee.bounds : boundsOfPoints(marquee.points);
		const selected = new Set<string>();
		for (const el of rt.page.elements) {
			// Un élément verrouillé n'entre jamais dans un lasso/rectangle : sinon
			// une sélection mixte (trait + image verrouillée) redevient
			// intransformable en bloc (voir isSelectionTransformable) sans qu'on
			// ait pu le voir venir, puisque le lasso n'entoure pas forcément
			// l'image de façon visible. Reste sélectionnable au clic direct
			// (voir hitTestElementAt), seul geste assez intentionnel pour ça.
			// Une forme n'a pas de champ `locked` : jamais concernée.
			if (el.type !== "shape" && el.locked) continue;
			const bounds = computeElementBounds(el);
			if (!boundsIntersect(bounds, marqueeBox)) continue;

			if (el.type === "stroke") {
				if (strokeSelectionRatio(el, marquee) >= STROKE_SELECTION_RATIO) selected.add(el.id);
			} else if (imageIntersectsMarquee(el, marquee, bounds)) {
				selected.add(el.id);
			}
		}
		this.setSelection(pageIndex, selected);
	}

	/**
	 * Finalise l'outil "capture" (voir onPointerDown, tool === "capture") : le
	 * rectangle tracé devient une image statique posée exactement à cet
	 * endroit — fond de page ET éléments compris, contrairement à un
	 * copier-coller de sélection qui n'embarque que des éléments (voir
	 * copySelectionToClipboard) — puisque c'est tout ce qu'il y avait sous les
	 * yeux qui doit être « capturé », comme une vraie capture d'écran.
	 */
	private finishCapture(): void {
		const marquee = this.currentMarqueeShape();
		const pageIndex = this.activeMarquee?.pageIndex ?? null;
		this.activeMarquee = null;
		if (!marquee || marquee.mode !== "rect" || pageIndex === null) return;
		if (!this.pages[pageIndex]) return;

		const { bounds } = marquee;
		const width = bounds.maxX - bounds.minX;
		const height = bounds.maxY - bounds.minY;
		if (width < MIN_CAPTURE_SIZE_PX || height < MIN_CAPTURE_SIZE_PX) return; // un simple clic, sans intention de capturer

		void this.performCapture(pageIndex, bounds, width, height);
	}

	/**
	 * Rasterise `bounds` (repère de la page) en PNG puis l'insère comme une
	 * image ordinaire. Attend d'abord le chargement des images de la page
	 * (voir imageCache.waitFor, même précaution que l'export PDF plus haut) :
	 * sans ça, une image encore en cours de décodage capturerait son état
	 * « en cours de chargement » plutôt que son contenu réel. Contrairement à
	 * une image collée/importée, le PNG n'est PAS écrit comme pièce jointe
	 * séparée dans le coffre : encodé en data URI directement dans
	 * ImageElement.path (voir model.ts), il vit entièrement dans le fichier
	 * .draw — une capture est dérivée du contenu déjà présent sur la page,
	 * lui créer un fichier à côté serait une redondance pure, jamais un ajout
	 * de contenu externe comme le sont les autres images.
	 */
	private async performCapture(pageIndex: number, bounds: StrokeBounds, width: number, height: number): Promise<void> {
		const page = this.pages[pageIndex].page;
		const imageElements = page.elements.filter((el): el is ImageElement => el.type === "image");
		await Promise.all(imageElements.map((el) => this.imageCache.waitFor(el, this.doc.pdfSources)));

		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(width * CAPTURE_SCALE));
		canvas.height = Math.max(1, Math.round(height * CAPTURE_SCALE));
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.setTransform(CAPTURE_SCALE, 0, 0, CAPTURE_SCALE, -bounds.minX * CAPTURE_SCALE, -bounds.minY * CAPTURE_SCALE);
		renderScene(ctx, page, this.currentColors(), {
			highlighterBehind: this.plugin.settings.highlighterAlwaysBehind,
			clip: bounds,
			resolveImage: this.resolveImage,
		});

		const element: ImageElement = {
			id: newStrokeId(),
			type: "image",
			path: canvas.toDataURL("image/png"),
			x: bounds.minX,
			y: bounds.minY,
			width,
			height,
			rotation: 0,
		};
		this.addManyElements(pageIndex, [element]);

		// Même geste qu'après une forme fraîchement tracée (voir finishShape) :
		// bascule sur le lasso, déjà sélectionnée par addManyElements, pour
		// pouvoir la replacer tout de suite ; revient seul au stylo au prochain
		// clic dans le vide (returnToPenAfterDeselect, armé APRÈS setTool
		// puisque setTool le remet lui-même à faux).
		this.setTool("select");
		this.returnToPenAfterDeselect = true;
		this.autoSelectShapeId = element.id;
	}

	// --- Transformation (déplacement, redimensionnement, rotation) --------------

	private startTransform(pageIndex: number, kind: TransformSession["kind"], startLogical: [number, number], handle?: ResizeHandle): void {
		const bounds = this.selectionBounds();
		if (!bounds) return;
		const page = this.pages[pageIndex].page;
		const snapshot = page.elements.filter((el) => this.selectedIds.has(el.id)).map((el) => this.cloneElement(el));
		this.transformSession = {
			pageIndex,
			kind,
			handle,
			originalBounds: bounds,
			snapshot,
			startLogical,
			currentTransformed: snapshot.map((el) => this.cloneElement(el)),
		};
		this.beginTransformBackground();
		this.scheduleActiveRedraw();
	}

	/**
	 * Rendu unique (pas par frame) du cache de la page concernée SANS les
	 * éléments sélectionnés, à la même échelle que son cache normal — voir
	 * TransformSession et "Performance" dans la fonctionnalité : sans ce
	 * cliché, blitter le cache existant laisserait les éléments sélectionnés
	 * visibles deux fois (leur position d'origine dans le cache, ET leur
	 * position transformée par-dessus).
	 */
	private beginTransformBackground(): void {
		const session = this.transformSession;
		if (!session) return;
		const rt = this.pages[session.pageIndex];
		if (!rt.cacheCanvas.width || !rt.cacheCanvas.height) return;
		const buffer = document.createElement("canvas");
		buffer.width = rt.cacheCanvas.width;
		buffer.height = rt.cacheCanvas.height;
		const ctx = buffer.getContext("2d");
		if (!ctx) return;
		ctx.setTransform(rt.cacheScale, 0, 0, rt.cacheScale, 0, 0);
		renderScene(ctx, rt.page, this.currentColors(), {
			elements: rt.page.elements.filter((el) => !this.selectedIds.has(el.id)),
			highlighterBehind: this.plugin.settings.highlighterAlwaysBehind,
			resolveImage: this.resolveImage,
		});
		this.transformBgCanvas = buffer;
	}

	private updateTransform(current: [number, number], shiftKey: boolean): void {
		const session = this.transformSession;
		if (!session) return;

		if (session.kind === "move") {
			// Les pages ne sont empilées que VERTICALEMENT (voir layoutPages) :
			// il n'existe jamais de page voisine à gauche ou à droite. Le mur
			// horizontal reste donc en place (borne X sur la largeur de la page
			// d'origine) — sans lui, une image glissée sur le côté irait se
			// perdre dans le vide, sans jamais atteindre une page pour
			// l'accueillir. Le mur vertical, lui, disparaît : glisser vers le
			// haut ou le bas peut franchir la frontière jusqu'à la page
			// voisine — voir commitTransform, qui fait alors réellement migrer
			// chaque élément vers la page où il se trouve désormais.
			const b = session.originalBounds;
			const page = this.pages[session.pageIndex].page;
			const dx = clamp(current[0] - session.startLogical[0], -b.minX, page.width - b.maxX);
			const dy = current[1] - session.startLogical[1];
			session.currentTransformed = session.snapshot.map((el) => this.translateElement(el, dx, dy));
		} else if (session.kind === "resize") {
			session.currentTransformed = this.computeResize(session, current, shiftKey);
		} else {
			session.currentTransformed = this.computeRotate(session, current, shiftKey);
		}
		this.scheduleActiveRedraw();
	}

	private translateElement(el: DrawElement, dx: number, dy: number): DrawElement {
		if (el.type === "stroke") {
			return { ...el, points: el.points.map(([x, y, p]) => [x + dx, y + dy, p] as Pt) };
		}
		return { ...el, x: el.x + dx, y: el.y + dy };
	}

	private computeResize(session: TransformSession, current: [number, number], shiftKey: boolean): DrawElement[] {
		const handle = session.handle;
		if (!handle) return session.currentTransformed;
		const axes = HANDLE_AXES[handle];
		const { minX, minY, maxX, maxY } = session.originalBounds;
		const origWidth = Math.max(1e-6, maxX - minX);
		const origHeight = Math.max(1e-6, maxY - minY);

		const anchorX = axes.x === 1 ? minX : maxX;
		const anchorY = axes.y === 1 ? minY : maxY;
		const rawWidth = axes.x === 1 ? current[0] - minX : axes.x === -1 ? maxX - current[0] : origWidth;
		const rawHeight = axes.y === 1 ? current[1] - minY : axes.y === -1 ? maxY - current[1] : origHeight;
		const newWidth = Math.max(4, rawWidth);
		const newHeight = Math.max(4, rawHeight);

		let sx = axes.x === 0 ? 1 : newWidth / origWidth;
		let sy = axes.y === 0 ? 1 : newHeight / origHeight;

		if (shiftKey && axes.x !== 0 && axes.y !== 0) {
			const s = Math.max(sx, sy);
			sx = s;
			sy = s;
		}

		// Une mise à l'échelle affecte aussi l'épaisseur des traits (voir scaleElement) : sinon un texte réduit garderait des traits épais et deviendrait illisible.
		const sizeScale = Math.sqrt(Math.abs(sx * sy)) || 1;
		return session.snapshot.map((el) => this.scaleElement(el, anchorX, anchorY, sx, sy, sizeScale));
	}

	private scaleElement(el: DrawElement, ax: number, ay: number, sx: number, sy: number, sizeScale: number): DrawElement {
		const scalePoint = (x: number, y: number): [number, number] => [ax + (x - ax) * sx, ay + (y - ay) * sy];
		if (el.type === "stroke") {
			return {
				...el,
				size: Math.max(0.5, el.size * sizeScale),
				points: el.points.map(([x, y, p]) => {
					const [nx, ny] = scalePoint(x, y);
					return [nx, ny, p] as Pt;
				}),
			};
		}
		const [nx, ny] = scalePoint(el.x, el.y);
		if (el.type === "shape" && (el.shape === "line" || el.shape === "arrow")) {
			// width/height signés encodent leur direction (voir ShapeElement,
			// model.ts) : jamais Math.abs (inverserait la direction) ni de
			// plancher à 2 (empêcherait de réduire le trait presque à un point,
			// ce qu'on accepte ici — contrairement à une image ou un
			// rectangle/ellipse, une ligne quasi nulle ne pose pas de problème
			// de rendu ou de resélection).
			return {
				...el,
				x: nx,
				y: ny,
				width: el.width * sx,
				height: el.height * sy,
				size: Math.max(0.5, el.size * sizeScale),
			};
		}
		return {
			...el,
			x: nx,
			y: ny,
			width: Math.max(2, el.width * Math.abs(sx)),
			height: Math.max(2, el.height * Math.abs(sy)),
			...(el.type === "shape" ? { size: Math.max(0.5, el.size * sizeScale) } : {}),
		};
	}

	private computeRotate(session: TransformSession, current: [number, number], shiftKey: boolean): DrawElement[] {
		const { minX, minY, maxX, maxY } = session.originalBounds;
		const cx = (minX + maxX) / 2;
		const cy = (minY + maxY) / 2;
		const startAngle = Math.atan2(session.startLogical[1] - cy, session.startLogical[0] - cx) * (180 / Math.PI);
		const currentAngle = Math.atan2(current[1] - cy, current[0] - cx) * (180 / Math.PI);
		let delta = currentAngle - startAngle;
		if (shiftKey) delta = Math.round(delta / SELECTION_ROTATE_SNAP_DEG) * SELECTION_ROTATE_SNAP_DEG;
		return session.snapshot.map((el) => this.rotateElement(el, cx, cy, delta));
	}

	private rotateElement(el: DrawElement, cx: number, cy: number, deltaDeg: number): DrawElement {
		if (el.type === "stroke") {
			return {
				...el,
				points: el.points.map(([x, y, p]) => {
					const r = rotatePointAround(x, y, cx, cy, deltaDeg);
					return [r.x, r.y, p] as Pt;
				}),
			};
		}
		const centerX = el.x + el.width / 2;
		const centerY = el.y + el.height / 2;
		const r = rotatePointAround(centerX, centerY, cx, cy, deltaDeg);
		return {
			...el,
			x: r.x - el.width / 2,
			y: r.y - el.height / 2,
			rotation: (((el.rotation + deltaDeg) % 360) + 360) % 360,
		};
	}

	/** Une seule entrée d'historique pour tout le geste, du pointerdown au pointerup — jamais une par frame (voir TransformSession). */
	private commitTransform(): void {
		const session = this.transformSession;
		this.transformSession = null;
		this.transformBgCanvas = null;
		if (!session) return;

		const before = session.snapshot;
		const after = session.currentTransformed;
		const changed = before.some((el, i) => JSON.stringify(el) !== JSON.stringify(after[i]));
		if (!changed) {
			this.scheduleActiveRedraw();
			return;
		}

		if (session.kind === "move") {
			this.commitMove(session.pageIndex, before, after);
			return;
		}

		// Redimensionnement ou rotation : jamais de changement de page (voir
		// updateTransform), un simple remplacement en place suffit.
		const page = this.pages[session.pageIndex].page;
		for (let i = 0; i < page.elements.length; i++) {
			const replacement = after.find((el) => el.id === page.elements[i].id);
			if (replacement) page.elements[i] = replacement;
		}
		this.history.push(session.pageIndex, { type: "transform", before, after });
		this.updateHistoryButtons();
		this.requestSave();
		this.render(session.pageIndex);
	}

	/**
	 * Termine un déplacement : chaque élément décide de SA PROPRE page de
	 * destination selon le centre de SA propre boîte englobante — jamais
	 * celle de toute la sélection. Sans ça, une sélection à cheval sur deux
	 * pages (une image glissée sur la page suivante pendant qu'un trait, resté
	 * en arrière, n'a pas franchi la frontière) migrait tout le groupe en bloc
	 * selon un seul centre commun : la partie restée en arrière se
	 * retrouvait hors des limites de sa page, son rendu tronqué au bord du
	 * cache de CETTE page — un cache est dimensionné exactement à sa page,
	 * jamais au-delà (voir regeneratePageCache) — donc invisible.
	 *
	 * Les éléments qui restent sur `fromPage` sont remplacés en place, comme
	 * un déplacement ordinaire (une seule entrée d'historique "transform").
	 * Ceux qui migrent sont groupés par page de destination — un
	 * CrossPageMove par groupe — reparentés (retirés de `fromPage.elements`,
	 * ajoutés à celle de destination), leurs coordonnées reconverties dans
	 * son repère (un simple décalage constant, les pages partageant le même
	 * repère document). La sélection suit les éléments déplacés sur leur
	 * nouvelle page plutôt que de se vider ; s'ils se répartissent sur
	 * plusieurs pages à la fois (rare : il faudrait franchir deux frontières
	 * dans le même geste), elle finit sur la dernière page traitée.
	 */
	private commitMove(fromPage: number, before: DrawElement[], after: DrawElement[]): void {
		const fromRt = this.pages[fromPage];

		const staying: { before: DrawElement; after: DrawElement }[] = [];
		const byDestPage = new Map<number, { before: DrawElement; after: DrawElement }[]>();

		for (let i = 0; i < before.length; i++) {
			const afterEl = after[i];
			const bounds = computeElementBounds(afterEl);
			const centerX = (bounds.minX + bounds.maxX) / 2;
			const centerY = (bounds.minY + bounds.maxY) / 2;
			const [docX, docY] = this.pageToDocument(fromPage, centerX, centerY);
			const dest = this.hitPage(docX, docY);
			if (dest === null || dest === fromPage) {
				staying.push({ before: before[i], after: afterEl });
			} else {
				const list = byDestPage.get(dest) ?? [];
				list.push({ before: before[i], after: afterEl });
				byDestPage.set(dest, list);
			}
		}

		if (staying.length > 0) {
			for (const { after: afterEl } of staying) {
				const i = fromRt.page.elements.findIndex((el) => el.id === afterEl.id);
				if (i !== -1) fromRt.page.elements[i] = afterEl;
			}
			this.history.push(fromPage, {
				type: "transform",
				before: staying.map((s) => s.before),
				after: staying.map((s) => s.after),
			});
		}

		let resultPage = fromPage;
		let resultIds = staying.map((s) => s.after.id);

		for (const [destPage, list] of byDestPage) {
			const toRt = this.pages[destPage];
			const offsetX = fromRt.originX - toRt.originX;
			const offsetY = fromRt.originY - toRt.originY;
			const moved = list.map(({ before: beforeEl, after: afterEl }) => ({
				index: fromRt.page.elements.findIndex((el) => el.id === beforeEl.id),
				before: beforeEl,
				after: this.translateElement(afterEl, offsetX, offsetY),
			}));

			const ids = new Set(moved.map((m) => m.before.id));
			fromRt.page.elements = fromRt.page.elements.filter((el) => !ids.has(el.id));
			toRt.page.elements.push(...moved.map((m) => m.after));

			this.history.pushMove({ fromPage, toPage: destPage, moved });
			resultPage = destPage;
			resultIds = moved.map((m) => m.after.id);
			this.render(destPage);
		}

		this.setSelection(resultPage, resultIds);
		this.updateHistoryButtons();
		this.requestSave();
		this.render(fromPage);
	}

	private cancelTransform(): void {
		this.transformSession = null;
		this.transformBgCanvas = null;
		this.scheduleActiveRedraw();
	}

	// --- Opérations sur la sélection ----------------------------------------------

	private deleteSelection(): void {
		if (this.selectedIds.size === 0 || this.selectedPageIndex === null) return;
		const pageIndex = this.selectedPageIndex;
		const page = this.pages[pageIndex].page;
		const removed: { index: number; element: DrawElement }[] = [];
		page.elements.forEach((el, i) => {
			if (this.selectedIds.has(el.id)) removed.push({ index: i, element: el });
		});
		if (removed.length === 0) return;

		const ids = new Set(removed.map((r) => r.element.id));
		page.elements = page.elements.filter((el) => !ids.has(el.id));
		this.history.push(pageIndex, { type: "remove", removed });
		this.clearSelection();
		this.updateHistoryButtons();
		this.requestSave();
		this.render(pageIndex);
	}

	private offsetClone(el: DrawElement, dx: number, dy: number): DrawElement {
		const moved = this.translateElement(this.cloneElement(el), dx, dy);
		return { ...moved, id: newStrokeId() };
	}

	private addManyElements(pageIndex: number, elements: DrawElement[]): void {
		if (elements.length === 0) return;
		const page = this.pages[pageIndex].page;
		page.elements.push(...elements);
		this.history.push(pageIndex, { type: "addMany", elements });
		this.setSelection(pageIndex, elements.map((el) => el.id));
		this.updateHistoryButtons();
		this.requestSave();
		this.render(pageIndex);
	}

	private duplicateSelection(): void {
		if (this.selectedIds.size === 0 || this.selectedPageIndex === null) return;
		const pageIndex = this.selectedPageIndex;
		const page = this.pages[pageIndex].page;
		const clones = page.elements
			.filter((el) => this.selectedIds.has(el.id))
			.map((el) => this.offsetClone(el, PASTE_OFFSET_PX, PASTE_OFFSET_PX));
		this.addManyElements(pageIndex, clones);
	}

	/** Sélectionne tout le contenu de la page la plus récemment ciblée par un geste (voir focusedPageIndex) — Ctrl+A ne porte que sur UNE page à la fois, jamais sur tout le document. */
	private selectAll(): void {
		const rt = this.pages[this.focusedPageIndex];
		if (!rt) return;
		this.setSelection(this.focusedPageIndex, rt.page.elements.map((el) => el.id));
	}

	/** Une entrée d'historique par appui (voir onWindowKeyDown) : les touches fléchées ne sont pas des événements continus comme un glissement, chaque appui est déjà une action discrète. */
	private nudgeSelection(dx: number, dy: number): void {
		if (this.selectedIds.size === 0 || this.selectedPageIndex === null) return;
		const pageIndex = this.selectedPageIndex;
		const page = this.pages[pageIndex].page;
		const before: DrawElement[] = [];
		const after: DrawElement[] = [];
		for (let i = 0; i < page.elements.length; i++) {
			const el = page.elements[i];
			if (!this.selectedIds.has(el.id)) continue;
			before.push(this.cloneElement(el));
			const moved = this.translateElement(el, dx, dy);
			page.elements[i] = moved;
			after.push(moved);
		}
		if (before.length === 0) return;
		this.history.push(pageIndex, { type: "transform", before, after });
		this.updateHistoryButtons();
		this.requestSave();
		this.render(pageIndex);
	}

	private handleSelectionNudgeKey(evt: KeyboardEvent, dx: number, dy: number): false | undefined {
		if (!isSelectionTool(this.plugin.settings.tool) || this.selectedIds.size === 0) return;
		if (!this.isSelectionTransformable()) return; // élément verrouillé : les flèches ne le déplacent pas (voir isSelectionTransformable)
		evt.preventDefault();
		const step = evt.shiftKey ? SELECTION_NUDGE_FAST_PX : SELECTION_NUDGE_PX;
		this.nudgeSelection(dx * step, dy * step);
		return false;
	}

	/** Couleur/épaisseur (voir recolorSelection/resizeSelectionThickness) : les deux seuls types qui ont ces champs sont les traits ET les formes (voir ShapeElement, model.ts) — une image n'a ni couleur ni épaisseur de contour, jamais concernée ici. */
	private transformSelectedColorable(fn: (s: StrokeElement | ShapeElement) => StrokeElement | ShapeElement): void {
		if (this.selectedPageIndex === null) return;
		const pageIndex = this.selectedPageIndex;
		const page = this.pages[pageIndex].page;
		const before: DrawElement[] = [];
		const after: DrawElement[] = [];
		for (let i = 0; i < page.elements.length; i++) {
			const el = page.elements[i];
			if (!this.selectedIds.has(el.id) || (el.type !== "stroke" && el.type !== "shape")) continue;
			before.push(this.cloneElement(el));
			const updated = fn(el);
			page.elements[i] = updated;
			after.push(updated);
		}
		if (before.length === 0) return;
		this.history.push(pageIndex, { type: "transform", before, after });
		this.updateHistoryButtons();
		this.requestSave();
		this.render(pageIndex);
	}

	/**
	 * Comme transformSelectedColorable, mais pour les images : le verrouillage
	 * n'a de sens que pour une image (voir toggleSelectionLock) — un trait
	 * présent dans la même sélection n'est ni lu ni modifié, pas même inclus
	 * dans l'entrée d'historique.
	 */
	private transformSelectedImages(fn: (el: ImageElement) => ImageElement): void {
		if (this.selectedPageIndex === null) return;
		const pageIndex = this.selectedPageIndex;
		const page = this.pages[pageIndex].page;
		const before: DrawElement[] = [];
		const after: DrawElement[] = [];
		for (let i = 0; i < page.elements.length; i++) {
			const el = page.elements[i];
			if (!this.selectedIds.has(el.id) || el.type !== "image") continue;
			before.push(this.cloneElement(el));
			const updated = fn(el);
			page.elements[i] = updated;
			after.push(updated);
		}
		if (before.length === 0) return;
		this.history.push(pageIndex, { type: "transform", before, after });
		this.updateHistoryButtons();
		this.requestSave();
		this.render(pageIndex);
	}

	/**
	 * Bouton « Rogner » de la barre d'outils (voir cropBtn, visible pour une
	 * seule image sélectionnée — updateSelectionActionsToolbar) : ouvre
	 * CropImageModal sur son bitmap déjà résolu (voir imageCache.ts, attendu
	 * via waitFor — jamais lancé sur une image encore « en cours de
	 * chargement » ou en erreur), applique le résultat via
	 * transformSelectedImages pour rester annulable comme n'importe quelle
	 * autre modification d'image (verrouillage, déplacement…).
	 */
	private async openCropDialog(): Promise<void> {
		if (this.selectedPageIndex === null) return;
		const page = this.pages[this.selectedPageIndex].page;
		const el = page.elements.find(
			(candidate): candidate is ImageElement => this.selectedIds.has(candidate.id) && candidate.type === "image"
		);
		if (!el) return;

		const resolution = await this.imageCache.waitFor(el, this.doc.pdfSources);
		if (resolution.status !== "ready") {
			new Notice("Image not found or unreadable: cannot crop.");
			return;
		}

		new CropImageModal(this.app, resolution.image, el.crop ?? null, (crop) => {
			this.transformSelectedImages((image) => this.applyCrop(image, crop));
		}).open();
	}

	/**
	 * Applique un rognage en RÉDUISANT le cadre affiché à la taille de la
	 * portion qui reste visible, plutôt que de garder l'ancien cadre et d'y
	 * réétirer le contenu rogné (ce que ferait un simple `{...el, crop}` :
	 * visuellement, rogner ne changerait alors jamais rien à l'écran tant
	 * que le cadre n'est pas aussi redimensionné à la main). `crop` (comme
	 * `el.crop`) est TOUJOURS exprimé en fractions de l'image SOURCE
	 * complète (voir CropImageModal, qui affiche toujours l'image entière
	 * comme fond) : `scaleX`/`scaleY` convertissent une fraction de l'image
	 * source en unités du dessin, à partir du rapport déjà connu entre le
	 * cadre actuel et la portion qu'il montre actuellement (`el.crop`, ou
	 * l'image entière si absent) — ce qui reste correct en rognant une
	 * seconde fois une image déjà rognée. `x`/`y` se décalent d'autant que le
	 * bord gauche/haut du nouveau rognage s'est déplacé par rapport à
	 * l'ancien, pour que la partie qui reste visible ne saute pas à l'écran :
	 * seuls les bords effectivement rognés bougent.
	 */
	private applyCrop(el: ImageElement, crop: NonNullable<ImageElement["crop"]>): ImageElement {
		const previousCrop = el.crop ?? { x: 0, y: 0, width: 1, height: 1 };
		const scaleX = el.width / previousCrop.width;
		const scaleY = el.height / previousCrop.height;
		return {
			...el,
			crop,
			x: el.x + (crop.x - previousCrop.x) * scaleX,
			y: el.y + (crop.y - previousCrop.y) * scaleY,
			width: crop.width * scaleX,
			height: crop.height * scaleY,
		};
	}

	/**
	 * Verrouille toutes les images de la sélection qui ne le sont pas encore ;
	 * si elles le sont déjà toutes, déverrouille tout — même bascule
	 * "tout ou rien" qu'un bouton de mise en forme à l'état mixte. Un trait ne
	 * peut pas être verrouillé : le bouton reste masqué tant que la sélection
	 * ne contient aucune image (voir updateSelectionActionsToolbar), et cette
	 * méthode ne fait rien dans ce cas.
	 */
	private toggleSelectionLock(): void {
		if (this.selectedIds.size === 0 || this.selectedPageIndex === null) return;
		const page = this.pages[this.selectedPageIndex].page;
		const hasImage = page.elements.some((el) => this.selectedIds.has(el.id) && el.type === "image");
		if (!hasImage) return;
		const lock = !this.isSelectionFullyLocked();
		this.transformSelectedImages((el) => ({ ...el, locked: lock }));
		this.updateSelectionActionsToolbar();
		// render() (dans transformSelectedImages) ne redessine que le cache/committedCanvas :
		// les poignées et les badges cadenas vivent sur activeCanvas, voir drawLockIcons/drawSelectionOverlay.
		this.scheduleActiveRedraw();
	}

	private recolorSelection(color: string): void {
		this.transformSelectedColorable((s) => ({ ...s, color }));
	}

	private resizeSelectionThickness(size: number): void {
		this.transformSelectedColorable((s) => ({ ...s, size }));
	}

	private reorderSelection(combine: (selected: DrawElement[], rest: DrawElement[]) => DrawElement[]): void {
		if (this.selectedIds.size === 0 || this.selectedPageIndex === null) return;
		const pageIndex = this.selectedPageIndex;
		const page = this.pages[pageIndex].page;
		const before = [...page.elements];
		const selected = page.elements.filter((el) => this.selectedIds.has(el.id));
		const rest = page.elements.filter((el) => !this.selectedIds.has(el.id));
		const after = combine(selected, rest);
		page.elements = after;
		this.history.push(pageIndex, { type: "reorder", before, after: [...after] });
		this.updateHistoryButtons();
		this.requestSave();
		this.render(pageIndex);
	}

	private bringSelectionToFront(): void {
		this.reorderSelection((selected, rest) => [...rest, ...selected]);
	}

	private sendSelectionToBack(): void {
		this.reorderSelection((selected, rest) => [...selected, ...rest]);
	}

	/**
	 * Page sous le centre du volet visible, ou la plus proche verticalement
	 * si ce centre tombe dans l'interligne entre deux pages — jamais un
	 * retour silencieux à la page 0, qui surprendrait après un défilement
	 * profond dans un long cahier. Sert de page cible par défaut pour coller
	 * ou insérer une image (voir pasteElements/placeAndInsertImage) : ces
	 * gestes n'ont pas de position de clic propre, contrairement à un tracé.
	 */
	private centerVisiblePageIndex(): number | null {
		if (!this.wrapper || this.pages.length === 0) return null;
		const rect = this.wrapper.getBoundingClientRect();
		const [cx, cy] = this.screenToDocument(rect.width / 2, rect.height / 2);
		const hit = this.hitPage(cx, cy);
		if (hit !== null) return hit;

		let closest: number | null = null;
		let closestDist = Infinity;
		for (let i = 0; i < this.pages.length; i++) {
			const rt = this.pages[i];
			const mid = rt.originY + rt.page.height / 2;
			const dist = Math.abs(mid - cy);
			if (dist < closestDist) {
				closestDist = dist;
				closest = i;
			}
		}
		return closest;
	}

	// --- Presse-papier -------------------------------------------------------------

	/**
	 * Snapshot transparent (pas la page entière, pas de fond) de la sélection,
	 * recadré à sa boîte englobante — c'est ce qui part vers le presse-papier
	 * système pour permettre le collage vers des applications externes.
	 */
	private renderSelectionSnapshot(elements: DrawElement[], pageWidth: number, pageHeight: number): HTMLCanvasElement | null {
		let bounds: StrokeBounds | null = null;
		for (const el of elements) {
			const b = computeElementBounds(el);
			bounds = bounds
				? {
						minX: Math.min(bounds.minX, b.minX),
						minY: Math.min(bounds.minY, b.minY),
						maxX: Math.max(bounds.maxX, b.maxX),
						maxY: Math.max(bounds.maxY, b.maxY),
				  }
				: b;
		}
		if (!bounds) return null;

		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(bounds.maxX - bounds.minX));
		canvas.height = Math.max(1, Math.round(bounds.maxY - bounds.minY));
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		ctx.translate(-bounds.minX, -bounds.minY);
		const colors = this.currentColors();
		for (const el of elements) {
			drawElement(ctx, el, pageWidth, pageHeight, colors.paper, this.resolveImage);
		}
		return canvas;
	}

	/**
	 * Sérialise la sélection en JSON dans le presse-papier (voir
	 * CLIPBOARD_MARKER) — permet de coller d'une feuille à l'autre, OU D'UNE
	 * PAGE À L'AUTRE au sein de la même feuille, sans perte, sans passer par
	 * une image bitmap. Sur desktop, écrit AUSSI une image dans le
	 * presse-papier système, dans le même geste : elle seule est
	 * compréhensible par une application extérieure à Obsidian.
	 *
	 * Utilise electron.clipboard (voir getElectron) plutôt que
	 * navigator.clipboard (l'API Clipboard du navigateur) quand Electron est
	 * disponible (desktop) : cette dernière exige un document focalisé ET une
	 * activation utilisateur encore valide au moment précis de l'appel, deux
	 * conditions qu'Obsidian ne garantit pas de façon fiable pour une vue
	 * personnalisée comme celle-ci — d'où le Ctrl+C/Ctrl+V silencieusement
	 * inopérant avec cette API sur desktop. electron.clipboard est synchrone
	 * et n'a besoin d'aucune des deux. Sur mobile (pas d'Electron),
	 * navigator.clipboard reste le seul choix : le format interne (coller
	 * d'une page/feuille à l'autre dans Obsidian) fonctionne, mais jamais
	 * l'image système pour une appli externe.
	 */
	private copySelectionToClipboard(): void {
		if (this.selectedIds.size === 0 || this.selectedPageIndex === null) return;
		const page = this.pages[this.selectedPageIndex].page;
		const elements = page.elements
			.filter((el) => this.selectedIds.has(el.id))
			.map((el) => this.inlinePdfSourceForClipboard(this.cloneElement(el)));
		const payload: ClipboardPayload = { marker: CLIPBOARD_MARKER, elements };
		const json = JSON.stringify(payload);

		const electron = getElectron();
		if (electron) {
			const canvas = this.renderSelectionSnapshot(elements, page.width, page.height);
			if (canvas) {
				electron.clipboard.write({ text: json, image: electron.nativeImage.createFromDataURL(canvas.toDataURL("image/png")) });
			} else {
				electron.clipboard.writeText(json);
			}
			return;
		}

		navigator.clipboard.writeText(json).catch(() => new Notice("Couldn't copy to the clipboard."));
	}

	/**
	 * Le presse-papier doit rester autonome (voir copySelectionToClipboard,
	 * qui permet un collage vers une AUTRE feuille) : une page de PDF importée
	 * n'y référence donc jamais une clé de `Drawing.pdfSources` (qui
	 * n'existerait pas forcément dans le document cible du collage), mais le
	 * data URI complet du PDF, comme au format d'origine du plugin. Pendant
	 * de internPdfSourceFromClipboard() côté collage. Sans effet sur un
	 * élément qui n'est pas une page de PDF importée.
	 */
	private inlinePdfSourceForClipboard(el: DrawElement): DrawElement {
		if (el.type !== "image" || el.pdfPage == null || el.path.startsWith("data:")) return el;
		const dataUri = this.doc.pdfSources?.[el.path];
		return dataUri ? { ...el, path: dataUri } : el;
	}

	private cutSelection(): void {
		if (this.selectedIds.size === 0) return;
		this.copySelectionToClipboard();
		this.deleteSelection();
	}

	private tryParseClipboardPayload(text: string): DrawElement[] | null {
		try {
			const data = JSON.parse(text) as Partial<ClipboardPayload>;
			if (data.marker === CLIPBOARD_MARKER && Array.isArray(data.elements)) return data.elements;
		} catch {
			// Pas du JSON, ou pas notre format : ce n'est simplement pas un collage interne.
		}
		return null;
	}

	/**
	 * Colle des éléments déjà désérialisés sur la page actuellement visible
	 * au centre du volet (voir centerVisiblePageIndex — permet un
	 * copier-coller entre pages, y compris d'une feuille à l'autre) :
	 * décalés de quelques pixels (jamais exactement sur l'original),
	 * sélectionnés, avec un outil de sélection actif pour pouvoir les
	 * ajuster tout de suite — curseur ou lasso, celui déjà actif s'il y en a
	 * un (voir isSelectionTool), sinon le lasso par défaut.
	 */
	private pasteElements(elements: DrawElement[]): void {
		const pageIndex = this.centerVisiblePageIndex() ?? this.focusedPageIndex;
		const clones = elements
			.map((el) => this.internPdfSourceFromClipboard(el))
			.map((el) => this.offsetClone(el, PASTE_OFFSET_PX, PASTE_OFFSET_PX));
		if (!isSelectionTool(this.plugin.settings.tool)) {
			this.plugin.settings.tool = "select";
			void this.plugin.saveSettings();
			this.syncToolbarState();
		}
		this.addManyElements(pageIndex, clones);
	}

	/**
	 * Pendant de inlinePdfSourceForClipboard() côté copie : un élément collé
	 * dont `pdfPage` est présent arrive avec le PDF entier inline (format
	 * autonome du presse-papier) — jamais stocké tel quel sur la page,
	 * sans quoi coller plusieurs fois la même page dupliquerait le PDF à
	 * chaque collage (exactement le problème que buildPdfPages évite déjà à
	 * l'import, voir main.ts). Réutilise une entrée déjà identique en contenu
	 * de `Drawing.pdfSources` (voir internPdfSource) plutôt que d'en créer
	 * une nouvelle à chaque collage. Sans effet sur un élément qui n'est pas
	 * une page de PDF importée.
	 */
	private internPdfSourceFromClipboard(el: DrawElement): DrawElement {
		if (el.type !== "image" || el.pdfPage == null || !el.path.startsWith("data:")) return el;
		return { ...el, path: this.internPdfSource(el.path) };
	}

	/** Id existant de `this.doc.pdfSources` dont le contenu vaut déjà `dataUri`, sinon une nouvelle entrée — jamais deux entrées pour le même contenu. */
	private internPdfSource(dataUri: string): string {
		const sources = (this.doc.pdfSources ??= {});
		for (const [id, existing] of Object.entries(sources)) {
			if (existing === dataUri) return id;
		}
		const id = newPdfSourceId();
		sources[id] = dataUri;
		return id;
	}

	/**
	 * Collage — depuis Ctrl+V (this.scope.register(["Mod"], "v", ...)), le
	 * menu contextuel ou le bouton de la barre d'outils. Sur desktop, même
	 * presse-papier natif Electron que copySelectionToClipboard, lu ici de
	 * façon synchrone (voir sa doc pour pourquoi navigator.clipboard ne
	 * convenait pas) : priorité au presse-papier interne (voir
	 * CLIPBOARD_MARKER, une copie de sélection écrit aussi le JSON à côté de
	 * l'image système), à défaut une image externe (capture d'écran, image
	 * copiée depuis une autre appli). Sur mobile (pas d'Electron, voir
	 * getElectron), seul le format interne est lu, via navigator.clipboard —
	 * asynchrone, donc cette méthode l'est aussi ; une lecture refusée
	 * (permission, contexte non sécurisé) est traitée comme un presse-papier
	 * vide, jamais une erreur qui remonte à l'appelant.
	 */
	private async pasteFromClipboard(): Promise<void> {
		const electron = getElectron();
		if (electron) {
			const text = electron.clipboard.readText();
			const elements = text ? this.tryParseClipboardPayload(text) : null;
			if (elements) {
				this.pasteElements(elements);
				return;
			}

			const image = electron.clipboard.readImage();
			if (!image.isEmpty()) {
				void this.insertImageFromBlob(new Blob([new Uint8Array(image.toPNG())], { type: "image/png" }));
				return;
			}

			new Notice("No compatible content in the clipboard.");
			return;
		}

		let text: string | null = null;
		try {
			text = await navigator.clipboard.readText();
		} catch {
			// Traité comme un presse-papier vide, voir le message ci-dessous.
		}
		const elements = text ? this.tryParseClipboardPayload(text) : null;
		if (elements) {
			this.pasteElements(elements);
			return;
		}

		new Notice("No compatible content in the clipboard.");
	}

	/** « Insérer une image » : sélecteur de fichier natif, restreint aux formats acceptés. */
	private openImagePicker(): void {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/png,image/jpeg,image/webp,image/gif";
		input.addEventListener("change", () => {
			const file = input.files?.[0];
			if (file) void this.insertImageFromBlob(file);
		});
		input.click();
	}

	/**
	 * Pipeline commun aux trois voies d'insertion (collage, menu, sélecteur de
	 * fichier) : valide le format, lit les dimensions naturelles, encode le
	 * blob en data URI (voir blobToDataUrl, images.ts), puis place et
	 * enregistre l'élément. Aucun fichier séparé n'est écrit dans le coffre —
	 * l'image vit entièrement dans le .draw (voir ImageElement.path,
	 * model.ts), comme une capture de zone ou un PDF importé.
	 */
	private async insertImageFromBlob(blob: Blob): Promise<void> {
		const extension = extensionForMime(blob.type);
		if (!extension) {
			new Notice(`Unsupported image format (${blob.type || "unknown"}). PNG, JPEG, WebP, or GIF only.`);
			return;
		}

		let dims: { width: number; height: number };
		try {
			dims = await readImageDimensions(blob);
		} catch (error) {
			console.error("[quillstone] Image illisible :", error);
			new Notice("Unreadable image, insertion cancelled.");
			return;
		}

		let dataUrl: string;
		try {
			dataUrl = await blobToDataUrl(blob);
		} catch (error) {
			console.error("[quillstone] Lecture de l'image impossible :", error);
			new Notice("Couldn't read this image.");
			return;
		}

		this.placeAndInsertImage(dataUrl, dims);
	}

	/**
	 * Redimensionne (au plus IMAGE_MAX_WIDTH_RATIO de la largeur de la page
	 * ciblée, ratio conservé — jamais agrandie au-delà de sa taille
	 * naturelle) et centre sur la page actuellement visible au centre du
	 * volet (voir centerVisiblePageIndex), pas sur le document entier : sur
	 * un cahier de plusieurs pages, l'image doit apparaître sous les yeux,
	 * pas sur une page qu'on ne regarde pas. Annulable comme n'importe quel
	 * ajout (voir history.ts, action "addImage") — un undo ne laisse ici
	 * aucun fichier orphelin dans le coffre, `path` étant un data URI
	 * (voir insertImageFromBlob), pas un chemin vers un fichier séparé.
	 */
	private placeAndInsertImage(path: string, dims: { width: number; height: number }): void {
		const pageIndex = this.centerVisiblePageIndex() ?? this.focusedPageIndex;
		const rt = this.pages[pageIndex];
		if (!rt) return;
		const page = rt.page;

		const maxWidth = page.width * IMAGE_MAX_WIDTH_RATIO;
		const ratio = dims.width > 0 ? dims.height / dims.width : 1;
		const width = Math.min(dims.width, maxWidth);
		const height = width * ratio;

		const wrapperRect = this.wrapper.getBoundingClientRect();
		const [centerDocX, centerDocY] = this.screenToDocument(wrapperRect.width / 2, wrapperRect.height / 2);
		const [centerX, centerY] = this.toPageLocal(pageIndex, centerDocX, centerDocY);

		// Le centre du volet peut déborder de la page ciblée (panoramique,
		// zoom, page plus petite que l'écran) : la position centrée est
		// ensuite ramenée dans les limites de la page, jamais l'image posée à
		// moitié hors feuille.
		const x = clamp(centerX - width / 2, 0, Math.max(0, page.width - width));
		const y = clamp(centerY - height / 2, 0, Math.max(0, page.height - height));

		const element: ImageElement = {
			id: newStrokeId(),
			type: "image",
			path,
			x,
			y,
			width,
			height,
			rotation: 0,
		};

		page.elements.push(element);
		this.history.push(pageIndex, { type: "addImage", element });
		this.updateHistoryButtons();
		this.requestSave();
		this.render(pageIndex);
	}
}
