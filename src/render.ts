import { BackgroundKind, DrawElement, Density, DrawingPage, ImageElement, Pt, ShapeElement, Stroke, StrokeElement, TextAlign, TextElement, newStrokeId } from "./model";

/**
 * Rendu d'une feuille sur un contexte 2D.
 * Ce module ne connaît rien d'Obsidian : il sera réutilisé tel quel
 * pour l'aperçu intégré dans les notes et pour l'export image.
 */

/** 1mm en pixels logiques à 96 dpi (96 / 25.4 ≈ 3,78), pour les fonds aux proportions réelles (seyès, portées, isométrique). */
const MM = 96 / 25.4;

const GRID_STEP = 40; // ≈ 1 cm à 96 dpi
const LINE_STEP = 48;
const DOT_STEP = 40;
/** Densité appliquée à grid/lines/dots uniquement : les autres fonds ont leurs propres proportions réelles fixes. */
const DENSITY_SCALE: Record<Density, number> = { tight: 0.7, normal: 1, wide: 1.4 };

const SEYES_LINE_STEP = 2 * MM; // lignes fines tous les 2mm
const SEYES_HEAVY_EVERY = 4; // une ligne plus marquée toutes les 4 lignes fines (8mm), comme un vrai cahier Seyès
const SEYES_MARGIN = 25 * MM; // marge verticale gauche, ≈2,5cm

const STAFF_LINE_SPACING = 2 * MM; // écart entre les 5 lignes d'une portée
const STAFF_GROUP_GAP = 10 * MM; // espace entre deux portées

const ISO_STEP = 5 * MM; // longueur d'arête de la grille triangulaire isométrique
const ISO_ANGLE = Math.PI / 6; // 30°

function paintBackground(
	ctx: CanvasRenderingContext2D,
	kind: BackgroundKind,
	width: number,
	height: number,
	paper: string,
	ink: string,
	density: Density
): void {
	ctx.save();

	ctx.fillStyle = paper;
	ctx.fillRect(0, 0, width, height);

	ctx.strokeStyle = ink;
	ctx.fillStyle = ink;
	ctx.lineWidth = 1;

	const scale = DENSITY_SCALE[density];

	if (kind === "grid") {
		const step = GRID_STEP * scale;
		ctx.beginPath();
		for (let x = step; x < width; x += step) {
			ctx.moveTo(x + 0.5, 0);
			ctx.lineTo(x + 0.5, height);
		}
		for (let y = step; y < height; y += step) {
			ctx.moveTo(0, y + 0.5);
			ctx.lineTo(width, y + 0.5);
		}
		ctx.stroke();
	} else if (kind === "lines") {
		const step = LINE_STEP * scale;
		ctx.beginPath();
		for (let y = step; y < height; y += step) {
			ctx.moveTo(0, y + 0.5);
			ctx.lineTo(width, y + 0.5);
		}
		ctx.stroke();
	} else if (kind === "dots") {
		const step = DOT_STEP * scale;
		for (let x = step; x < width; x += step) {
			for (let y = step; y < height; y += step) {
				ctx.beginPath();
				ctx.arc(x, y, 1.4, 0, Math.PI * 2);
				ctx.fill();
			}
		}
	} else if (kind === "seyes") {
		// Lignes fines tous les 2mm ; une ligne sur quatre (tous les 8mm) est
		// plus marquée, comme la réglure Seyès des cahiers scolaires français.
		ctx.lineWidth = 1;
		ctx.beginPath();
		for (let y = SEYES_LINE_STEP; y < height; y += SEYES_LINE_STEP) {
			const isHeavy = Math.round(y / SEYES_LINE_STEP) % SEYES_HEAVY_EVERY === 0;
			if (isHeavy) continue;
			ctx.moveTo(0, y + 0.5);
			ctx.lineTo(width, y + 0.5);
		}
		ctx.stroke();

		const heavyStep = SEYES_LINE_STEP * SEYES_HEAVY_EVERY;
		ctx.lineWidth = 1.6;
		ctx.beginPath();
		for (let y = heavyStep; y < height; y += heavyStep) {
			ctx.moveTo(0, y + 0.5);
			ctx.lineTo(width, y + 0.5);
		}
		// Marge verticale gauche.
		ctx.moveTo(SEYES_MARGIN + 0.5, 0);
		ctx.lineTo(SEYES_MARGIN + 0.5, height);
		ctx.stroke();
	} else if (kind === "staff") {
		// Groupes de 5 lignes espacées (une portée), séparés par un intervalle plus large.
		const staffHeight = STAFF_LINE_SPACING * 4;
		const period = staffHeight + STAFF_GROUP_GAP;
		ctx.beginPath();
		for (let top = STAFF_GROUP_GAP; top < height; top += period) {
			for (let line = 0; line < 5; line++) {
				const y = top + line * STAFF_LINE_SPACING;
				if (y >= height) break;
				ctx.moveTo(0, y + 0.5);
				ctx.lineTo(width, y + 0.5);
			}
		}
		ctx.stroke();
	} else if (kind === "isometric") {
		// Grille triangulaire : verticales, plus deux familles de diagonales à ±30°.
		ctx.beginPath();
		for (let x = 0; x <= width; x += ISO_STEP) {
			ctx.moveTo(x + 0.5, 0);
			ctx.lineTo(x + 0.5, height);
		}
		const run = height / Math.tan(ISO_ANGLE);
		for (let c = -run; c <= width + run; c += ISO_STEP) {
			ctx.moveTo(c, 0);
			ctx.lineTo(c + run, height);
			ctx.moveTo(c, 0);
			ctx.lineTo(c - run, height);
		}
		ctx.stroke();
	}

	ctx.restore();
}

/**
 * Le quadrillage ne change jamais entre deux frames (seuls le type de fond ou
 * les couleurs du thème le font, et rarement). Le recalculer à chaque appel
 * de drawBackground serait le premier poste de coût d'un redessin déclenché
 * à haute fréquence (ex. la gomme). On le peint donc une seule fois dans un
 * tampon hors écran, réutilisé tel quel tant que (type, dimensions, couleurs)
 * n'ont pas changé, et simplement recopié avec drawImage.
 */
let backgroundCache: { canvas: HTMLCanvasElement; key: string } | null = null;

function cachedBackground(
	kind: BackgroundKind,
	width: number,
	height: number,
	paper: string,
	ink: string,
	density: Density
): HTMLCanvasElement {
	const key = `${kind}|${width}|${height}|${paper}|${ink}|${density}`;
	if (!backgroundCache || backgroundCache.key !== key) {
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const cctx = canvas.getContext("2d");
		if (cctx) paintBackground(cctx, kind, width, height, paper, ink, density);
		backgroundCache = { canvas, key };
	}
	return backgroundCache.canvas;
}

export function drawBackground(
	ctx: CanvasRenderingContext2D,
	kind: BackgroundKind,
	width: number,
	height: number,
	paper: string,
	ink: string,
	density: Density = "normal"
): void {
	ctx.drawImage(cachedBackground(kind, width, height, paper, ink, density), 0, 0, width, height);
}

function midpoint(a: Pt, b: Pt): [number, number] {
	return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

// --- Stylo : lissage et modulation par la pression -------------------------
//
// Un trait n'est jamais relié par des segments droits (anguleux sur de
// l'écriture manuscrite). Chaque morceau de courbe relie le milieu de deux
// points capturés au milieu des deux points suivants, en utilisant le point
// du milieu comme point de contrôle d'une courbe quadratique. Seuls le tout
// premier et le tout dernier morceau restent des segments droits, du point
// de départ/arrivée réel jusqu'au premier/dernier milieu. Chaque morceau est
// tracé séparément (son propre appel à stroke()) avec son propre lineWidth :
// c'est ce qui permet à l'épaisseur de varier le long du trait. Le stylo
// dessine à pleine opacité, donc ce découpage en plusieurs stroke() ne pose
// pas le problème d'accumulation de transparence du surligneur (voir plus bas).

interface StrokeSegment {
	start: [number, number];
	control: [number, number];
	end: [number, number];
	width: number;
}

/** Le stylet inactif ou une souris rapporte toujours 0.5 : ce n'est pas une vraie pression. */
const MOUSE_PRESSURE = 0.5;
const PRESSURE_MIN_SCALE = 0.5;
const PRESSURE_MAX_SCALE = 1.5;

/**
 * Convertit une pression (0-1) en épaisseur. À la souris (pression toujours
 * à 0.5), la modulation ne représenterait rien : on garde l'épaisseur de
 * base du trait, constante.
 */
function widthForPressure(size: number, pressure: number): number {
	if (pressure === MOUSE_PRESSURE) return size;
	const scale = PRESSURE_MIN_SCALE + pressure * (PRESSURE_MAX_SCALE - PRESSURE_MIN_SCALE);
	return size * scale;
}

function buildSegment(prev: Pt, cur: Pt, next: Pt, size: number): StrokeSegment {
	return {
		start: midpoint(prev, cur),
		control: [cur[0], cur[1]],
		end: midpoint(cur, next),
		// L'épaisseur du morceau interpole la pression entre ses deux extrémités.
		width: widthForPressure(size, (prev[2] + next[2]) / 2),
	};
}

function strokeSegments(stroke: Stroke): StrokeSegment[] {
	const pts = stroke.points;
	const segments: StrokeSegment[] = [];
	for (let i = 1; i < pts.length - 1; i++) {
		segments.push(buildSegment(pts[i - 1], pts[i], pts[i + 1], stroke.size));
	}
	return segments;
}

function applyPenStyle(ctx: CanvasRenderingContext2D, stroke: Stroke, width: number): void {
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.strokeStyle = stroke.color;
	ctx.globalAlpha = 1;
	ctx.lineWidth = width;
}

function paintDot(ctx: CanvasRenderingContext2D, stroke: Stroke, at: Pt): void {
	const width = widthForPressure(stroke.size, at[2]);
	ctx.save();
	applyPenStyle(ctx, stroke, width);
	ctx.beginPath();
	ctx.moveTo(at[0], at[1]);
	ctx.lineTo(at[0] + 0.01, at[1]);
	ctx.stroke();
	ctx.restore();
}

function paintStraight(
	ctx: CanvasRenderingContext2D,
	stroke: Stroke,
	from: [number, number],
	to: [number, number],
	width: number
): void {
	ctx.save();
	applyPenStyle(ctx, stroke, width);
	ctx.beginPath();
	ctx.moveTo(from[0], from[1]);
	ctx.lineTo(to[0], to[1]);
	ctx.stroke();
	ctx.restore();
}

function paintCurveSegment(ctx: CanvasRenderingContext2D, stroke: Stroke, seg: StrokeSegment): void {
	ctx.save();
	applyPenStyle(ctx, stroke, seg.width);
	ctx.beginPath();
	ctx.moveTo(seg.start[0], seg.start[1]);
	ctx.quadraticCurveTo(seg.control[0], seg.control[1], seg.end[0], seg.end[1]);
	ctx.stroke();
	ctx.restore();
}

function drawPenStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
	const pts = stroke.points;
	if (pts.length === 0) return;

	if (pts.length === 1) {
		paintDot(ctx, stroke, pts[0]);
		return;
	}

	if (pts.length === 2) {
		const width = widthForPressure(stroke.size, (pts[0][2] + pts[1][2]) / 2);
		paintStraight(ctx, stroke, [pts[0][0], pts[0][1]], [pts[1][0], pts[1][1]], width);
		return;
	}

	const segments = strokeSegments(stroke);
	const first = pts[0];
	const last = pts[pts.length - 1];

	paintStraight(ctx, stroke, [first[0], first[1]], segments[0].start, segments[0].width);
	for (const seg of segments) paintCurveSegment(ctx, stroke, seg);
	const lastSeg = segments[segments.length - 1];
	paintStraight(ctx, stroke, lastSeg.end, [last[0], last[1]], lastSeg.width);
}

// --- Surligneur : chemin unique composé une seule fois ---------------------
//
// Le stylo peut se permettre plusieurs appels à stroke() séparés parce qu'il
// est opaque. Le surligneur est semi-transparent : si on le peignait de la
// même façon, chaque chevauchement entre morceaux (et un trait manuscrit se
// recroise souvent lui-même) cumulerait la transparence et laisserait des
// taches sombres. La correction : tracer tout le trait comme un seul chemin
// continu (un seul stroke()) à pleine opacité sur un tampon hors écran de la
// taille de la page, puis composer ce tampon une seule fois sur le canvas de
// destination avec la transparence voulue. La transparence ne s'applique
// donc qu'une fois, jamais aux chevauchements internes au trait. Épaisseur
// constante (pas de modulation par la pression) et lineCap/lineJoin "round"
// pour ne pas laisser de trous aux jonctions.
//
// La composition ne peut pas se contenter d'un globalCompositeOperation fixe.
// Sur papier clair, "multiply" teinte en assombrissant, comme un vrai
// surligneur (noir × n'importe quoi = noir, donc l'encre reste lisible en
// dessous). Mais sur papier sombre, multiply assombrit systématiquement : la
// couleur du surligneur tend vers le noir et l'effet disparaît. Sur papier
// sombre il faut donc éclaircir ("screen") pour rester visible. Le mode est
// donc choisi à chaque appel selon la luminance réelle de --qs-paper (pas
// selon la présence d'une classe de thème : un thème personnalisé peut avoir
// une couleur de papier de n'importe quelle luminance).

const HIGHLIGHTER_ALPHA_MULTIPLY = 0.35;
/**
 * "screen" pousse plus fort vers le blanc que "multiply" ne pousse vers le
 * noir pour un alpha équivalent (l'un des deux canaux part déjà de l'extrême
 * opposé côté encre foncée) : une opacité légèrement plus faible donne une
 * intensité perçue comparable, à ajuster visuellement si besoin.
 */
const HIGHLIGHTER_ALPHA_SCREEN = 0.3;
const LIGHT_LUMINANCE_THRESHOLD = 128; // sur 255 ; au-dessus, le papier est considéré clair

let highlighterBuffer: HTMLCanvasElement | null = null;
let colorProbe: HTMLCanvasElement | null = null;

/**
 * Résout n'importe quelle couleur CSS valide (hex, rgb(), hsl(), nom...) en
 * composantes RVB, en laissant le moteur de rendu du navigateur faire
 * l'analyse plutôt que de réimplémenter un parseur : fillStyle accepte tout
 * ce que CSS accepte, y compris une variable --qs-paper personnalisée par
 * l'utilisateur.
 */
function resolveToRGB(color: string): [number, number, number] {
	if (!colorProbe) colorProbe = document.createElement("canvas");
	if (colorProbe.width !== 1 || colorProbe.height !== 1) {
		colorProbe.width = 1;
		colorProbe.height = 1;
	}
	const pctx = colorProbe.getContext("2d");
	if (!pctx) return [255, 255, 255];
	pctx.clearRect(0, 0, 1, 1);
	pctx.fillStyle = color;
	pctx.fillRect(0, 0, 1, 1);
	const [r, g, b] = pctx.getImageData(0, 0, 1, 1).data;
	return [r, g, b];
}

/** Recalculée à chaque appel (jamais mise en cache) : un changement de thème à chaud doit être pris en compte immédiatement. */
function isLightPaper(paperColor: string): boolean {
	const [r, g, b] = resolveToRGB(paperColor);
	const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return luminance > LIGHT_LUMINANCE_THRESHOLD;
}

function ensureHighlighterBuffer(width: number, height: number): HTMLCanvasElement {
	if (!highlighterBuffer) highlighterBuffer = document.createElement("canvas");
	if (highlighterBuffer.width !== width || highlighterBuffer.height !== height) {
		highlighterBuffer.width = width;
		highlighterBuffer.height = height;
	}
	return highlighterBuffer;
}

function tracePath(ctx: CanvasRenderingContext2D, pts: Pt[]): void {
	ctx.beginPath();
	if (pts.length === 1) {
		ctx.moveTo(pts[0][0], pts[0][1]);
		ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
	} else if (pts.length === 2) {
		ctx.moveTo(pts[0][0], pts[0][1]);
		ctx.lineTo(pts[1][0], pts[1][1]);
	} else {
		ctx.moveTo(pts[0][0], pts[0][1]);
		const firstMid = midpoint(pts[0], pts[1]);
		ctx.lineTo(firstMid[0], firstMid[1]);
		for (let i = 1; i < pts.length - 1; i++) {
			const next = midpoint(pts[i], pts[i + 1]);
			ctx.quadraticCurveTo(pts[i][0], pts[i][1], next[0], next[1]);
		}
		const last = pts[pts.length - 1];
		ctx.lineTo(last[0], last[1]);
	}
	ctx.stroke();
}

function drawHighlighterStroke(
	destCtx: CanvasRenderingContext2D,
	stroke: Stroke,
	pageWidth: number,
	pageHeight: number,
	paperColor: string
): void {
	if (stroke.points.length === 0) return;

	const buffer = ensureHighlighterBuffer(pageWidth, pageHeight);
	const bctx = buffer.getContext("2d");
	if (!bctx) return;

	bctx.clearRect(0, 0, pageWidth, pageHeight);
	bctx.lineCap = "round";
	bctx.lineJoin = "round";
	bctx.lineWidth = stroke.size;
	bctx.strokeStyle = stroke.color;
	bctx.globalAlpha = 1;
	tracePath(bctx, stroke.points);

	const lightPaper = isLightPaper(paperColor);
	destCtx.save();
	destCtx.globalCompositeOperation = lightPaper ? "multiply" : "screen";
	destCtx.globalAlpha = lightPaper ? HIGHLIGHTER_ALPHA_MULTIPLY : HIGHLIGHTER_ALPHA_SCREEN;
	destCtx.drawImage(buffer, 0, 0);
	destCtx.restore();
}

export interface RenderColors {
	paper: string;
	rule: string;
}

/**
 * État de chargement d'un bitmap d'ImageElement, tel que le connaît
 * l'appelant (voir imageCache.ts, qui gère le cache HTMLImageElement indexé
 * par chemin — ce module n'en connaît rien, il ne fait que dessiner selon
 * l'état qu'on lui fournit). `CanvasImageSource` plutôt que `HTMLImageElement`
 * pour ne coupler ce type à rien de plus précis que ce qu'un `drawImage()`
 * accepte réellement.
 */
export type ImageResolution =
	| { status: "loading" }
	| { status: "error" }
	| { status: "ready"; image: CanvasImageSource };

export interface RenderSceneOptions {
	/** Éléments à peindre. Par défaut `page.elements` (rendu validé) ; on peut y ajouter le trait en cours pour le tracé en direct. */
	elements?: DrawElement[];
	/** Réglage « Surligneur toujours en arrière-plan » : voir renderScene. */
	highlighterBehind?: boolean;
	/**
	 * Ne repeint que cette zone (repère logique de la page) : fond + éléments
	 * dont la boîte englobante la recoupe, le reste du canvas n'est pas
	 * touché. Pour un redessin partiel bon marché après une modification
	 * localisée (la gomme) plutôt que de régénérer toute la page.
	 */
	clip?: StrokeBounds;
	/**
	 * Résout un ImageElement vers son état de chargement (voir imageCache.ts,
	 * fourni aussi bien par la vue principale que par l'aperçu intégré dans
	 * les notes — preview.ts). Reçoit l'élément entier, pas seulement
	 * `path` : une page de PDF importée (voir ImageElement.pdfPage) a besoin
	 * du numéro de page en plus du chemin pour savoir quel bitmap produire.
	 * Sans résolveur, toute image est peinte comme « en cours de chargement »
	 * — jamais silencieusement absente.
	 */
	resolveImage?: (el: ImageElement) => ImageResolution;
}

function renderRank(el: DrawElement): number {
	return el.type === "stroke" && el.tool === "highlighter" ? 0 : 1;
}

function boundsIntersectRect(a: StrokeBounds, b: StrokeBounds): boolean {
	return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/**
 * Boîte englobante d'un élément quelconque — trait, image ou forme (voir
 * strokeBounds pour le cas trait). Une image et une forme partagent le même
 * calcul, tenant compte de la rotation — sans ça, un élément pivoté près du
 * bord d'une zone d'effacement (voir renderScene, `clip`) pourrait être
 * exclu à tort du redessin partiel et sembler rogné jusqu'au prochain rendu
 * complet. Fonctionne aussi pour une ligne/flèche dont width/height sont
 * négatifs (voir ShapeElement, model.ts) : les 4 "coins" restent des
 * coordonnées valides à faire pivoter, juste celles d'un rectangle dégénéré.
 * Exportée : l'outil sélection (view.ts/selection.ts) en a aussi besoin,
 * pour le cadre englobant et le pré-filtre par boîte avant le test point par
 * point.
 */
export function computeElementBounds(el: DrawElement): StrokeBounds {
	if (el.type === "stroke") return strokeBounds(el);

	const cx = el.x + el.width / 2;
	const cy = el.y + el.height / 2;
	const rad = (el.rotation * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const hw = el.width / 2;
	const hh = el.height / 2;

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const [dx, dy] of [
		[-hw, -hh],
		[hw, -hh],
		[hw, hh],
		[-hw, hh],
	]) {
		const x = cx + dx * cos - dy * sin;
		const y = cy + dx * sin + dy * cos;
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	return { minX, minY, maxX, maxY };
}

/** Rectangle en tirets pendant le chargement du bitmap : jamais un vide silencieux. */
function drawImageLoadingBox(ctx: CanvasRenderingContext2D, width: number, height: number): void {
	ctx.fillStyle = "rgba(128, 128, 128, 0.15)";
	ctx.strokeStyle = "rgba(128, 128, 128, 0.5)";
	ctx.lineWidth = 1;
	ctx.setLineDash([6, 4]);
	ctx.beginPath();
	ctx.rect(0, 0, width, height);
	ctx.fill();
	ctx.stroke();
}

/**
 * Fichier introuvable (déplacé, renommé, supprimé hors du plugin...) : un
 * cadre d'erreur qui donne le chemin manquant, pour que l'utilisateur
 * comprenne et puisse corriger — jamais un simple vide qui laisserait croire
 * à un bug plutôt qu'à un fichier disparu.
 */
function drawImageErrorFrame(ctx: CanvasRenderingContext2D, width: number, height: number, path: string): void {
	ctx.fillStyle = "rgba(214, 69, 69, 0.1)";
	ctx.strokeStyle = "rgba(214, 69, 69, 0.7)";
	ctx.lineWidth = 1.5;
	ctx.setLineDash([]);
	ctx.beginPath();
	ctx.rect(0, 0, width, height);
	ctx.fill();
	ctx.stroke();

	if (width < 24 || height < 16) return; // trop petit pour un texte lisible, le cadre seul suffit à signaler l'anomalie

	ctx.save();
	ctx.beginPath();
	ctx.rect(0, 0, width, height);
	ctx.clip();
	ctx.fillStyle = "rgba(214, 69, 69, 0.9)";
	ctx.font = "12px sans-serif";
	ctx.textBaseline = "top";
	ctx.fillText("Image not found:", 6, 6);
	ctx.fillText(path, 6, 22);
	ctx.restore();
}

/** Dispatch selon l'état de chargement fourni par l'appelant (voir RenderSceneOptions.resolveImage) — ce module ne charge ni ne met rien en cache lui-même. */
/**
 * Dimensions intrinsèques d'un bitmap déjà chargé — `HTMLImageElement`
 * (naturalWidth/Height) et `HTMLCanvasElement` (width/height) n'exposent pas
 * la même paire de propriétés pour ça, malgré un `drawImage()` identique
 * pour les deux (voir ImageResolution, CanvasImageSource). Ce sont les deux
 * SEULS types que produit réellement imageCache.ts (bitmap collé, page de
 * PDF rendue) : les autres variantes de CanvasImageSource n'apparaissent
 * jamais ici, `HTMLCanvasElement` sert de repli pour satisfaire le type.
 * Exportée : cropModal.ts (fonctionnalité « rogner une image ») en a besoin
 * pour dimensionner son aperçu, sans dupliquer cette logique.
 */
export function intrinsicSize(image: CanvasImageSource): { width: number; height: number } {
	if (image instanceof HTMLImageElement) return { width: image.naturalWidth, height: image.naturalHeight };
	const canvas = image as HTMLCanvasElement;
	return { width: canvas.width, height: canvas.height };
}

function drawImageElement(ctx: CanvasRenderingContext2D, el: ImageElement, resolution: ImageResolution): void {
	ctx.save();
	ctx.translate(el.x + el.width / 2, el.y + el.height / 2);
	ctx.rotate((el.rotation * Math.PI) / 180);
	ctx.translate(-el.width / 2, -el.height / 2);

	if (resolution.status === "ready") {
		// Rogné (voir ImageElement.crop) : sous-rectangle SOURCE en pixels du
		// bitmap réellement chargé, jamais stocké en pixels lui-même (les
		// fractions restent valides même si ce bitmap change de résolution
		// d'une session à l'autre — voir la doc du champ, model.ts).
		const { width: naturalWidth, height: naturalHeight } = intrinsicSize(resolution.image);
		const crop = el.crop ?? { x: 0, y: 0, width: 1, height: 1 };
		ctx.drawImage(
			resolution.image,
			crop.x * naturalWidth,
			crop.y * naturalHeight,
			crop.width * naturalWidth,
			crop.height * naturalHeight,
			0,
			0,
			el.width,
			el.height
		);
	} else if (resolution.status === "error") {
		// Une capture, ou une image/PDF importé (voir ImageElement, model.ts)
		// encodent leur contenu en data URI, ou (pour une page de PDF) une clé
		// interne vers Drawing.pdfSources : un chemin illisible pour
		// l'utilisateur dans les deux cas, jamais affiché tel quel.
		const isDataUri = el.path.startsWith("data:");
		const label = el.pdfPage != null ? `PDF importé (page ${el.pdfPage})` : isDataUri ? "Capture" : el.path;
		drawImageErrorFrame(ctx, el.width, el.height, label);
	} else {
		drawImageLoadingBox(ctx, el.width, el.height);
	}

	ctx.restore();
}

/**
 * Une flèche : un trait de (x1,y1) à (x2,y2), plus deux courts segments
 * formant la pointe à l'arrivée, dans le prolongement de l'angle du trait —
 * jamais une tête pleine (triangle rempli), pour rester cohérente avec le
 * reste du plugin, qui ne dessine que des contours, jamais de remplissage.
 */
function strokeArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, size: number): void {
	ctx.beginPath();
	ctx.moveTo(x1, y1);
	ctx.lineTo(x2, y2);
	ctx.stroke();

	const angle = Math.atan2(y2 - y1, x2 - x1);
	const headLen = Math.max(10, size * 3);
	const spread = Math.PI / 7;
	ctx.beginPath();
	ctx.moveTo(x2 - headLen * Math.cos(angle - spread), y2 - headLen * Math.sin(angle - spread));
	ctx.lineTo(x2, y2);
	ctx.lineTo(x2 - headLen * Math.cos(angle + spread), y2 - headLen * Math.sin(angle + spread));
	ctx.stroke();
}

/**
 * Une forme prédéfinie (voir ShapeElement, model.ts) : rectangle, ellipse,
 * ligne ou flèche, dessinée en repère local (0,0)-(width,height) après
 * translation+rotation vers son cadre, exactement comme drawImageElement —
 * pour "line"/"arrow", width/height peuvent être négatifs (leur direction
 * même), ce qui reste un couple de coordonnées valide pour moveTo/lineTo,
 * jamais besoin de les normaliser ici.
 */
function drawShapeElement(ctx: CanvasRenderingContext2D, el: ShapeElement): void {
	ctx.save();
	ctx.translate(el.x + el.width / 2, el.y + el.height / 2);
	ctx.rotate((el.rotation * Math.PI) / 180);
	ctx.translate(-el.width / 2, -el.height / 2);

	ctx.strokeStyle = el.color;
	ctx.lineWidth = el.size;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.globalAlpha = 1;
	ctx.setLineDash([]);

	if (el.shape === "rectangle") {
		ctx.strokeRect(0, 0, el.width, el.height);
	} else if (el.shape === "triangle") {
		// Isocèle par convention (voir ShapeKind, model.ts) : sommet en haut au
		// centre, base pleine largeur en bas.
		ctx.beginPath();
		ctx.moveTo(el.width / 2, 0);
		ctx.lineTo(el.width, el.height);
		ctx.lineTo(0, el.height);
		ctx.closePath();
		ctx.stroke();
	} else if (el.shape === "ellipse") {
		ctx.beginPath();
		ctx.ellipse(el.width / 2, el.height / 2, Math.abs(el.width) / 2, Math.abs(el.height) / 2, 0, 0, Math.PI * 2);
		ctx.stroke();
	} else if (el.shape === "line") {
		ctx.beginPath();
		ctx.moveTo(0, 0);
		ctx.lineTo(el.width, el.height);
		ctx.stroke();
	} else {
		strokeArrow(ctx, 0, 0, el.width, el.height, el.size);
	}

	ctx.restore();
}

// --- Zone de texte -----------------------------------------------------------

/** TextElement.size (2/4/8, comme Stroke.size/ShapeElement.size) -> taille de police réelle en pixels logiques — un peu plus généreux qu'une simple épaisseur de trait (voir le bug signalé : un texte à l'épaisseur par défaut du stylo paraissait trop petit à l'écriture). */
const TEXT_FONT_SCALE = 7;
/** Exportée : view.ts applique le même interligne au textarea d'édition, pour que la zone éditée corresponde visuellement au rendu final une fois validée. */
export const TEXT_LINE_HEIGHT_RATIO = 1.3;
/**
 * Aucune marge interne entre le cadre de la zone de texte et le texte
 * lui-même : le cadre — donc le cadre de sélection affiché par l'outil
 * sélection, voir computeElementBounds — doit épouser le texte au pixel
 * près, jamais laisser de marge vide tout autour (voir le bug signalé).
 */
export const TEXT_PADDING_PX = 0;
/** Largeur (pixels logiques) au-delà de laquelle une zone de texte fraîchement créée (voir view.ts:startTextCreation/finishTextEditing) retourne à la ligne plutôt que de continuer à s'élargir — un texte redimensionné ensuite à la main peut dépasser cette largeur, elle ne s'applique qu'au calcul automatique. */
export const TEXT_MAX_WIDTH = 480;
const TEXT_FONT_FAMILY = "sans-serif";

export function textFontSize(size: number): number {
	return size * TEXT_FONT_SCALE;
}

function textFont(size: number): string {
	return `${textFontSize(size)}px ${TEXT_FONT_FAMILY}`;
}

/** Canvas hors écran dédié à la mesure de texte (ctx.measureText) — jamais affiché, comme colorProbe ci-dessus pour une raison différente (ici, avoir un contexte 2D disponible même hors de tout rendu en cours). */
let textMeasureCanvas: HTMLCanvasElement | null = null;

function textMeasureCtx(): CanvasRenderingContext2D | null {
	if (!textMeasureCanvas) textMeasureCanvas = document.createElement("canvas");
	return textMeasureCanvas.getContext("2d");
}

/**
 * Une ligne déjà retournée à la largeur voulue (voir wrapTextLines).
 * `lastOfParagraph` distingue la toute dernière ligne d'un paragraphe (un
 * retour à la ligne saisi par l'utilisateur, ou la fin du texte) d'une ligne
 * coupée seulement parce qu'elle débordait — seule la première ne doit
 * JAMAIS être justifiée (voir TextAlign, model.ts, et drawTextElement),
 * comme dans n'importe quel traitement de texte : une dernière ligne étirée
 * pour remplir toute la largeur, même à un seul mot, aurait l'air cassée.
 */
export interface WrappedLine {
	text: string;
	lastOfParagraph: boolean;
}

/**
 * Découpe `text` en lignes qui tiennent dans `maxWidth`, en respectant
 * d'abord les retours à la ligne saisis par l'utilisateur (chaque paragraphe
 * est ensuite retourné à la ligne indépendamment des autres), puis en coupant
 * mot par mot — jamais au milieu d'un mot ORDINAIRE, comme un traitement de
 * texte classique. Un mot à lui seul plus large que `maxWidth` (une longue
 * URL sans espace, par exemple — ou une chaîne de test sans espace du tout,
 * voir le bug signalé) est la SEULE exception : il est alors décomposé
 * caractère par caractère, comme le ferait nativement le textarea d'édition
 * (CSS `word-break: break-word`, voir styles.css) — sans cette exception, un
 * tel mot débordait silencieusement de sa boîte sans jamais retourner à la
 * ligne, alors même que l'édition en cours (elle, wrap nativement dans le
 * navigateur) laissait croire que tout fonctionnait. Utilisée à la fois pour
 * le rendu (drawTextElement) et pour calculer la hauteur d'une zone de texte
 * (measureTextHeight) : les deux doivent toujours s'accorder, sans quoi la
 * boîte affichée ne correspondrait plus au texte qu'elle contient.
 */
export function wrapTextLines(text: string, maxWidth: number, size: number): WrappedLine[] {
	const ctx = textMeasureCtx();
	if (!ctx) return text.split("\n").map((line) => ({ text: line, lastOfParagraph: true }));
	ctx.font = textFont(size);

	const lines: WrappedLine[] = [];
	for (const paragraph of text.split("\n")) {
		if (paragraph === "") {
			lines.push({ text: "", lastOfParagraph: true });
			continue;
		}
		let current = "";
		for (const word of paragraph.split(" ")) {
			const candidate = current ? `${current} ${word}` : word;
			if (ctx.measureText(candidate).width <= maxWidth) {
				current = candidate;
				continue;
			}

			// `candidate` déborde : la ligne en cours (s'il y en avait une) est
			// complète telle quelle.
			if (current) {
				lines.push({ text: current, lastOfParagraph: false });
				current = "";
			}

			if (ctx.measureText(word).width <= maxWidth) {
				current = word;
				continue;
			}

			// `word` seul dépasse encore maxWidth, même sur une ligne vide :
			// aucun espace à exploiter, on le décompose caractère par
			// caractère (voir la doc de la fonction).
			let chunk = "";
			for (const ch of word) {
				const withCh = chunk + ch;
				if (chunk && ctx.measureText(withCh).width > maxWidth) {
					lines.push({ text: chunk, lastOfParagraph: false });
					chunk = ch;
				} else {
					chunk = withCh;
				}
			}
			current = chunk;
		}
		lines.push({ text: current, lastOfParagraph: true });
	}
	return lines;
}

/**
 * Hauteur totale (pixels logiques, marges internes comprises) qu'il faut à
 * `text` pour tenir sur une largeur `width` — c'est cette valeur qui devient
 * TextElement.height à chaque modification du texte (voir view.ts), jamais
 * une valeur choisie à la main par l'utilisateur.
 */
export function measureTextHeight(text: string, width: number, size: number): number {
	const lines = wrapTextLines(text, Math.max(1, width - TEXT_PADDING_PX * 2), size);
	const lineHeight = textFontSize(size) * TEXT_LINE_HEIGHT_RATIO;
	return lines.length * lineHeight + TEXT_PADDING_PX * 2;
}

/**
 * Largeur/hauteur qui épousent exactement `text` — utilisée uniquement pour
 * un simple CLIC de l'outil texte (voir view.ts:finishTextBoxCreation) pour
 * qu'une boîte fraîchement tapée sans glissement ne laisse jamais de vide
 * entre son cadre (donc son cadre de sélection) et le texte, ni sur sa
 * largeur ni sur sa hauteur : `width` est la plus longue ligne UNE FOIS le
 * retour à la ligne appliqué à `maxWidth` (voir wrapTextLines), jamais
 * `maxWidth` lui-même. Sans effet sur une boîte créée par CLIC-GLISSÉ (sa
 * largeur reste celle dessinée) ni sur une boîte existante qu'on rouvre pour
 * la modifier : dans les deux cas, seule measureTextHeight recalcule la
 * hauteur à une largeur déjà fixée.
 */
export function measureTextBoxSize(text: string, size: number, maxWidth: number = TEXT_MAX_WIDTH): { width: number; height: number } {
	const lines = wrapTextLines(text, maxWidth, size);
	const lineHeight = textFontSize(size) * TEXT_LINE_HEIGHT_RATIO;
	const ctx = textMeasureCtx();
	let width = textFontSize(size); // jamais plus étroite qu'un caractère, pour une boîte tout juste créée sans texte
	if (ctx) {
		ctx.font = textFont(size);
		for (const line of lines) width = Math.max(width, ctx.measureText(line.text).width);
	} else {
		width = maxWidth;
	}
	return { width, height: lines.length * lineHeight };
}

/** Position X (repère local, avant justification) d'une ligne de largeur `lineWidth` dans une boîte de largeur `boxWidth` — "justify" partage l'alignement à gauche de "left" (drawJustifiedLine gère elle-même la répartition), seuls "center"/"right" ont une position propre. */
function alignedLineX(lineWidth: number, boxWidth: number, align: TextAlign): number {
	if (align === "center") return (boxWidth - lineWidth) / 2;
	if (align === "right") return boxWidth - lineWidth - TEXT_PADDING_PX;
	return TEXT_PADDING_PX;
}

/**
 * Une ligne "justify" : répartit l'espace EN TROP (largeur disponible moins
 * la somme des mots déjà espacés d'un espace normal) à parts égales entre
 * chaque mot, en redessinant mot par mot plutôt qu'avec un seul fillText —
 * ctx.fillText n'a aucun moyen natif d'étirer les espaces d'une chaîne. Un
 * seul mot (rien à répartir entre deux mots) retombe simplement sur un rendu
 * aligné à gauche.
 */
function drawJustifiedLine(ctx: CanvasRenderingContext2D, line: string, y: number, boxWidth: number): void {
	const words = line.split(" ").filter((w) => w.length > 0);
	if (words.length <= 1) {
		ctx.fillText(line, TEXT_PADDING_PX, y);
		return;
	}
	const wordWidths = words.map((w) => ctx.measureText(w).width);
	const totalWordWidth = wordWidths.reduce((sum, w) => sum + w, 0);
	const availableWidth = Math.max(0, boxWidth - TEXT_PADDING_PX * 2);
	const gap = Math.max(0, (availableWidth - totalWordWidth) / (words.length - 1));
	let x = TEXT_PADDING_PX;
	words.forEach((word, i) => {
		ctx.fillText(word, x, y);
		x += wordWidths[i] + gap;
	});
}

/**
 * Une zone de texte (voir TextElement, model.ts) : repère local comme
 * drawImageElement/drawShapeElement, coupé au cadre (jamais débordant sur le
 * reste de la page, même si measureTextHeight n'a pas encore été réappliquée
 * après une modification externe — un redimensionnement manuel de la boîte,
 * par exemple). L'alignement (TextElement.align, absent équivaut à "left")
 * ne change jamais le découpage en lignes (wrapTextLines) — seulement où
 * chaque ligne déjà calculée atterrit sur l'axe horizontal.
 */
function drawTextElement(ctx: CanvasRenderingContext2D, el: TextElement): void {
	ctx.save();
	ctx.translate(el.x + el.width / 2, el.y + el.height / 2);
	ctx.rotate((el.rotation * Math.PI) / 180);
	ctx.translate(-el.width / 2, -el.height / 2);

	ctx.beginPath();
	ctx.rect(0, 0, el.width, el.height);
	ctx.clip();

	ctx.fillStyle = el.color;
	ctx.font = textFont(el.size);
	ctx.textBaseline = "top";
	const align = el.align ?? "left";
	const lineHeight = textFontSize(el.size) * TEXT_LINE_HEIGHT_RATIO;
	const lines = wrapTextLines(el.text, Math.max(1, el.width - TEXT_PADDING_PX * 2), el.size);
	let y = TEXT_PADDING_PX;
	for (const line of lines) {
		if (align === "justify" && !line.lastOfParagraph) {
			drawJustifiedLine(ctx, line.text, y, el.width);
		} else {
			const lineWidth = ctx.measureText(line.text).width;
			ctx.fillText(line.text, alignedLineX(lineWidth, el.width, align), y);
		}
		y += lineHeight;
	}

	ctx.restore();
}

/**
 * Seul et unique endroit où l'ordre d'empilement des éléments est décidé.
 *
 * Par défaut, un simple passage dans l'ordre de création : un surligneur
 * tracé après un trait de stylo apparaît par-dessus, translucide, et laisse
 * le texte lisible — comme dans n'importe quelle application de prise de
 * notes. C'est la transparence qui fait le travail, pas un réordonnancement.
 * Une image se comporte comme un trait de stylo pour cet ordre : dessiner
 * sur une image puis coller une image par-dessus un dessin fonctionnent tous
 * deux, chacun selon l'ordre chronologique réel de création.
 *
 * Si `highlighterBehind` est vrai (réglage « Surligneur toujours en
 * arrière-plan »), les éléments sont d'abord triés (tri stable, donc l'ordre
 * relatif entre éléments de même rang est conservé) pour que tous les
 * surligneurs passent avant le reste, quel que soit leur ordre de création.
 * Aucune autre fonction ne doit trier ni séparer les éléments par type.
 *
 * `elements` par défaut à `page.elements` ; on peut y passer
 * `[...page.elements, traitEnCours]` pour que le tracé en direct obéisse
 * exactement au même ordre que le rendu validé, y compris pendant le geste —
 * c'est ce qui garantit qu'aucun saut visuel ne se produit au pointerup.
 *
 * Opère sur UNE SEULE page (voir DrawingPage, model.ts) : un document à
 * pages multiples appelle cette fonction une fois par page visible (voir
 * view.ts), jamais une seule fois pour tout le document.
 *
 * Renvoie le nombre d'éléments effectivement redessinés (sert à vérifier que
 * le cache n'est ni régénéré trop souvent, ni plus largement que nécessaire).
 */
export function renderScene(
	ctx: CanvasRenderingContext2D,
	page: DrawingPage,
	colors: RenderColors,
	options: RenderSceneOptions = {}
): number {
	const allElements = options.elements ?? page.elements;
	const clip = options.clip;
	const relevant = clip
		? allElements.filter((el) => boundsIntersectRect(computeElementBounds(el), clip))
		: allElements;
	const ordered = options.highlighterBehind
		? [...relevant].sort((a, b) => renderRank(a) - renderRank(b))
		: relevant;

	ctx.save();
	if (clip) {
		ctx.beginPath();
		ctx.rect(clip.minX, clip.minY, clip.maxX - clip.minX, clip.maxY - clip.minY);
		ctx.clip();
	}

	drawBackground(
		ctx,
		page.background,
		page.width,
		page.height,
		colors.paper,
		colors.rule,
		page.density
	);
	for (const el of ordered) {
		drawElement(ctx, el, page.width, page.height, colors.paper, options.resolveImage);
	}

	ctx.restore();
	return ordered.length;
}

/**
 * Dessine un seul élément, sans fond ni tri. Utilisé pour peindre uniquement
 * le trait en cours (voir view.ts:redrawActiveCanvas), ou les éléments
 * sélectionnés pendant une transformation (voir view.ts:redrawSelectionTransform) :
 * contrairement à renderScene, ça ne redessine pas toute la scène à chaque
 * frame, seulement ce qui change réellement.
 */
export function drawElement(
	ctx: CanvasRenderingContext2D,
	el: DrawElement,
	pageWidth: number,
	pageHeight: number,
	paperColor: string,
	resolveImage?: (el: ImageElement) => ImageResolution
): void {
	if (el.type === "image") {
		const resolution = resolveImage?.(el) ?? { status: "loading" };
		drawImageElement(ctx, el, resolution);
	} else if (el.type === "shape") {
		drawShapeElement(ctx, el);
	} else if (el.type === "text") {
		drawTextElement(ctx, el);
	} else if (el.tool === "highlighter") {
		drawHighlighterStroke(ctx, el, pageWidth, pageHeight, paperColor);
	} else {
		drawPenStroke(ctx, el);
	}
}

// --- Géométrie pour la gomme -------------------------------------------------

export interface StrokeBounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/**
 * Un trait n'est jamais modifié en place une fois créé (la gomme par zone
 * remplace un trait par de nouveaux fragments plutôt que de le muter) : sa
 * boîte englobante peut donc être calculée une seule fois et réutilisée pour
 * le reste de sa vie. La WeakMap fait office de « champ caché » associé à
 * l'objet trait, calculé à la première consultation et libéré automatiquement
 * quand le trait n'est plus référencé nulle part (plus besoin de la tenir à
 * jour à travers tous les points où `drawing.elements` change).
 */
const boundsCache = new WeakMap<Stroke, StrokeBounds>();

/** Boîte englobante d'un trait, en repère logique de la page. */
export function strokeBounds(stroke: Stroke): StrokeBounds {
	const cached = boundsCache.get(stroke);
	if (cached) return cached;

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of stroke.points) {
		if (p[0] < minX) minX = p[0];
		if (p[1] < minY) minY = p[1];
		if (p[0] > maxX) maxX = p[0];
		if (p[1] > maxY) maxY = p[1];
	}
	const bounds: StrokeBounds = { minX, minY, maxX, maxY };
	boundsCache.set(stroke, bounds);
	return bounds;
}

/**
 * Vrai si un cercle de rayon `radius` centré en (cx, cy) peut toucher cette
 * boîte englobante. Filtre rapide et bon marché à appliquer avant de tester
 * les points d'un trait un par un : sans lui, chaque geste de gomme
 * parcourrait tous les points de la page, ce qui devient lent dès quelques
 * centaines de traits.
 */
export function boundsNearCircle(
	bounds: StrokeBounds,
	cx: number,
	cy: number,
	radius: number
): boolean {
	const closestX = Math.max(bounds.minX, Math.min(cx, bounds.maxX));
	const closestY = Math.max(bounds.minY, Math.min(cy, bounds.maxY));
	return Math.hypot(cx - closestX, cy - closestY) <= radius;
}

/** Distance d'un point à un segment [a, b] — exportée : sert aussi à toucher une forme "ligne"/"flèche" (voir view.ts, hitTestElementAt/eraserTouchesLine), qui n'a pas de surface propre à tester contrairement à un rectangle ou une ellipse. */
export function distanceToSegment(
	p: [number, number],
	a: [number, number],
	b: [number, number]
): number {
	const abx = b[0] - a[0];
	const aby = b[1] - a[1];
	const lenSq = abx * abx + aby * aby;
	if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);

	let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / lenSq;
	t = Math.max(0, Math.min(1, t));
	const projX = a[0] + t * abx;
	const projY = a[1] + t * aby;
	return Math.hypot(p[0] - projX, p[1] - projY);
}

/**
 * Vrai si le trait passe à moins de `radius` du point donné. Teste la
 * distance point-segment entre chaque paire de points consécutifs, pas
 * seulement point-point : sur un trait rapide, les points capturés peuvent
 * être espacés de plus que le rayon de la gomme, alors que le trait lui-même
 * passe bien dessous. Utilisé par la gomme par trait entier, et comme test
 * rapide « ce trait est-il touché du tout » avant de calculer le découpage
 * détaillé de la gomme par zone (eraseZone).
 */
export function strokeHitTest(stroke: Stroke, point: [number, number], radius: number): boolean {
	const pts = stroke.points;
	if (pts.length === 0) return false;
	if (pts.length === 1) {
		return Math.hypot(point[0] - pts[0][0], point[1] - pts[0][1]) <= radius;
	}
	for (let i = 0; i < pts.length - 1; i++) {
		const a: [number, number] = [pts[i][0], pts[i][1]];
		const b: [number, number] = [pts[i + 1][0], pts[i + 1][1]];
		if (distanceToSegment(point, a, b) <= radius) return true;
	}
	return false;
}

/**
 * Gomme par zone : n'efface que la portion d'un trait à moins de `radius` du
 * point donné. Un point est marqué effacé si un segment auquel il appartient
 * passe à moins de `radius` du curseur (distance point-segment, pas
 * point-point). Les points survivants forment une ou plusieurs séquences
 * contiguës ; chaque séquence d'au moins deux points devient un nouveau
 * trait, avec un nouvel identifiant mais le même outil, la même couleur et
 * la même épaisseur que l'original. Un fragment d'un seul point est
 * abandonné : un trait a besoin d'au moins deux points pour exister.
 */
export function eraseZone(stroke: Stroke, cx: number, cy: number, radius: number): StrokeElement[] {
	const pts = stroke.points;
	const n = pts.length;
	if (n === 0) return [];

	const erased = new Array<boolean>(n).fill(false);
	if (n === 1) {
		erased[0] = Math.hypot(pts[0][0] - cx, pts[0][1] - cy) <= radius;
	} else {
		for (let i = 0; i < n - 1; i++) {
			const a: [number, number] = [pts[i][0], pts[i][1]];
			const b: [number, number] = [pts[i + 1][0], pts[i + 1][1]];
			if (distanceToSegment([cx, cy], a, b) <= radius) {
				erased[i] = true;
				erased[i + 1] = true;
			}
		}
	}

	const fragments: StrokeElement[] = [];
	let start = -1;
	for (let i = 0; i <= n; i++) {
		const survives = i < n && !erased[i];
		if (survives && start === -1) {
			start = i;
		} else if (!survives && start !== -1) {
			if (i - start >= 2) {
				fragments.push({
					id: newStrokeId(),
					type: "stroke",
					tool: stroke.tool,
					color: stroke.color,
					size: stroke.size,
					points: pts.slice(start, i),
				});
			}
			start = -1;
		}
	}
	return fragments;
}
