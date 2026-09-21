/**
 * Modèle de données d'une feuille de dessin.
 *
 * Le dessin est stocké en vectoriel : chaque trait est une suite de points.
 * Avantages par rapport à une image bitmap :
 *   - fichiers légers (quelques Ko pour une page manuscrite) ;
 *   - rendu net quel que soit le zoom ou la résolution d'écran ;
 *   - la gomme peut supprimer un trait entier proprement ;
 *   - le format reste lisible et diffable dans Git.
 */

/** Un point : abscisse, ordonnée, pression du stylet entre 0 et 1. */
export type Pt = [number, number, number];

/** Les seuls outils qui produisent un trait persisté ; la gomme en supprime, elle n'en crée pas. */
export type ToolKind = "pen" | "highlighter";

export type BackgroundKind = "blank" | "grid" | "lines" | "dots" | "seyes" | "staff" | "isometric";

export type Orientation = "portrait" | "landscape";

/** Espacement du quadrillage, appliqué à grid/lines/dots uniquement : seyes/staff/isometric ont leurs propres proportions réelles fixes. */
export type Density = "tight" | "normal" | "wide";

export interface Stroke {
	id: string;
	tool: ToolKind;
	color: string;
	/** Épaisseur de base en pixels, avant modulation par la pression. */
	size: number;
	points: Pt[];
}

/**
 * Un trait, tel que stocké dans `DrawingPage.elements` : les mêmes champs que
 * `Stroke`, avec le discriminant `type` qui permet au rendu (et à tout code
 * qui parcourt `elements`) de distinguer un trait d'un autre type d'élément
 * sans avoir à inspecter sa forme.
 */
export interface StrokeElement extends Stroke {
	type: "stroke";
	/** Verrouillé par l'outil sélection (voir view.ts) : reste sélectionnable, supprimable, copiable et changeable de plan, mais plus déplaçable, redimensionnable ni pivotable. Propriété du document, jamais réinitialisée à la relecture du .draw. */
	locked?: boolean;
}

/**
 * Image collée sur la feuille, OU page d'un PDF importé (voir `pdfPage`
 * ci-dessous) — les deux partagent la même forme. Pour une image ordinaire,
 * `path` est un data URI qui encode directement le contenu : une image
 * insérée (collage, sélecteur de fichier — voir DrawView.insertImageFromBlob,
 * view.ts) ou une capture de zone (voir DrawView.performCapture, son PNG)
 * n'écrivent AUCUN fichier séparé dans le coffre — chacune vit entièrement
 * dans le .draw qui la contient, jamais comme pièce jointe orpheline. Un
 * chemin relatif au coffre (vers un fichier du dossier de pièces jointes)
 * reste néanmoins accepté en lecture, pour les documents créés par une
 * version antérieure du plugin (voir ImageElementCache, imageCache.ts, qui
 * distingue les trois formes de `path`). Ce module ne résout ni ne charge
 * aucune d'elles — il ne connaît rien d'Obsidian ni du système de fichiers,
 * comme le reste de model.ts/render.ts. Position, dimensions et rotation
 * sont en unités du dessin, comme les points d'un trait — relatives à la
 * page qui contient l'image, jamais au document entier (voir DrawingPage).
 */
export interface ImageElement {
	id: string;
	type: "image";
	/**
	 * Pour une page de PDF importée (`pdfPage` présent), `path` est le
	 * chemin, relatif au coffre, du PDF écrit comme pièce jointe normale
	 * (voir main.ts:buildPdfPages) — un PDF de N pages n'existe qu'UNE
	 * SEULE fois dans le coffre, jamais une fois par page qui le référence.
	 * Deux formats plus anciens restent acceptés EN LECTURE, jamais produits
	 * par un nouvel import : une clé dans `Drawing.pdfSources` (voir sa
	 * doc — le PDF encodé une seule fois, mais en base64 DANS le .draw), ou
	 * un data URI directement ici (le tout premier format, le PDF encodé ET
	 * dupliqué à chaque page). Les deux ont été abandonnés pour la même
	 * raison : encoder un PDF volumineux en base64 dans le texte JSON du
	 * .draw finit, même une seule fois, par dépasser la longueur de chaîne
	 * maximale du moteur JS (`RangeError: Invalid string length` à l'écriture
	 * — c'est ce qui faisait échouer l'import d'un PDF de 61 pages), une
	 * limite qu'écrire un fichier binaire séparé élimine complètement.
	 */
	path: string;
	/**
	 * Absent pour une image ordinaire (`path` pointe alors directement vers
	 * un bitmap : PNG/JPEG/WebP/GIF). Présent (1-indexé, comme pdf.js) quand
	 * `path` pointe vers un PDF plutôt qu'un bitmap : la page à en extraire.
	 * Voir la doc de `path` ci-dessus : le bitmap de chaque page est rendu à
	 * la demande (voir imageCache.ts) plutôt que rasterisé et stocké à
	 * l'avance.
	 */
	pdfPage?: number;
	x: number;
	y: number;
	width: number;
	height: number;
	/** Degrés, sens horaire, pivote autour du centre de l'image. */
	rotation: number;
	/** Verrouillé par l'outil sélection (voir view.ts et StrokeElement.locked) : même comportement que pour un trait. */
	locked?: boolean;
	/**
	 * Portion visible du bitmap source, en fractions (0 à 1) de ses
	 * dimensions naturelles — absent équivaut à `{x:0, y:0, width:1,
	 * height:1}` (image entière, non rognée). Des fractions plutôt que des
	 * pixels : le rognage reste valide quelle que soit la résolution du
	 * bitmap réellement chargé (voir imageCache.ts — un PDF importé, voir
	 * `pdfPage`, peut être rendu à une résolution différente d'une session à
	 * l'autre). Le fichier original n'est JAMAIS recadré ni réencodé sur le
	 * disque : seule la portion affichée sur cette feuille change (voir
	 * render.ts:drawImageElement) — un undo, ou un rognage différent plus
	 * tard, retrouve toujours l'image complète disponible.
	 */
	crop?: { x: number; y: number; width: number; height: number };
}

/**
 * Les formes prédéfinies de la palette (voir view.ts) — le carré et le rond
 * n'ont pas leur propre valeur : ce sont un rectangle, respectivement une
 * ellipse, tracés avec Maj maintenue (rapport 1:1), comme le
 * redimensionnement d'une sélection le fait déjà ailleurs dans le plugin.
 * "triangle" est TOUJOURS isocèle par convention dans son rectangle
 * englobant (sommet en haut au centre, base en bas), jamais pivoté : un
 * triangle reconnu à main levée comme équilatéral (voir
 * view.ts:recognizeClosedShape) devient un "polygon" à 3 sommets réels
 * plutôt que ce gabarit, justement pour pouvoir retrouver l'orientation
 * réellement dessinée (l'englobante d'un triangle pivoté n'est PAS centrée
 * sur son centroïde, un premier essai qui pivotait ce gabarit isocèle
 * produisait une orientation fausse). "polygon"/"polyline" n'existent QUE
 * reconnues à main levée (jamais dans la palette de formes) : voir
 * ShapeElement.vertices, qui porte leurs sommets réels — n'importe quel
 * contour à coins nets (étoile, pentagone, triangle équilatéral, flèche en
 * chevron, zigzag...) que "rectangle"/"ellipse"/"triangle" ne peuvent pas
 * représenter.
 */
export type ShapeKind = "rectangle" | "ellipse" | "triangle" | "line" | "arrow" | "polygon" | "polyline";

/**
 * Une forme prédéfinie, tracée par glissement avec la palette de formes OU
 * reconnue automatiquement à partir d'un tracé au stylo/surligneur maintenu
 * immobile (voir view.ts, respectivement l'outil forme et
 * recognizeClosedShape/recognizeOpenPolyline). `x`/`y`/`width`/`height`/
 * `rotation` fonctionnent comme pour ImageElement — un rectangle englobant
 * avant rotation, pivoté autour de son centre — SAUF pour "line"/"arrow" :
 * `width`/`height` PEUVENT être négatifs pour ces deux formes, le trait
 * allant du point (x, y) au point (x + width, y + height). C'est ce signe
 * qui encode leur direction, jamais `rotation` seule (qui reste disponible
 * en plus, pour une rotation ultérieure via la poignée de sélection) —
 * contrairement à "rectangle"/"ellipse"/"triangle"/"polygon"/"polyline", où
 * width/height restent toujours positifs comme pour une image. Cette
 * différence est ce qui distingue leur code dans scaleElement/
 * hitTestElementAt/etc. (voir view.ts) : toutes les formes partagent presque
 * tout le reste (déplacer, pivoter, dupliquer, copier) sans code dédié, par
 * simple compatibilité de forme avec ImageElement. Jamais verrouillable (pas
 * de champ `locked`, contrairement à StrokeElement/ImageElement) — hors de
 * portée de cette première version.
 */
export interface ShapeElement {
	id: string;
	type: "shape";
	shape: ShapeKind;
	x: number;
	y: number;
	width: number;
	height: number;
	rotation: number;
	/** Couleur du contour — jamais de remplissage dans cette première version. */
	color: string;
	/** Épaisseur du contour, comme Stroke.size. */
	size: number;
	/**
	 * Sommets, UNIQUEMENT pour `shape` "polygon" (contour refermé — étoile,
	 * pentagone, quadrilatère non rectangulaire...) ou "polyline" (contour
	 * OUVERT — chevron, flèche en angle, zigzag) ; absent pour toute autre
	 * forme. Coordonnées en FRACTION (0 à 1) de `width`/`height`, jamais en
	 * pixels absolus — comme ImageElement.crop, pour rester valides tel
	 * quel après n'importe quel redimensionnement (scaleElement, voir
	 * view.ts) : ni lui ni updateRecognizedShapeScale n'ont besoin de
	 * connaître "polygon"/"polyline" pour continuer à fonctionner, aucun des
	 * deux ne touchant jamais `vertices`. Dans l'ordre du tracé ; "polygon"
	 * referme automatiquement du dernier sommet au premier au rendu (voir
	 * render.ts:drawShapeElement), "polyline" jamais.
	 */
	vertices?: { x: number; y: number }[];
}

/** Alignement horizontal du texte à l'intérieur de sa boîte — voir TextElement.align, render.ts:drawTextElement. "justify" étire chaque ligne pour remplir toute la largeur en espaçant ses mots, SAUF la dernière ligne d'un paragraphe (retour à la ligne saisi par l'utilisateur, ou toute dernière ligne du texte) — comme dans n'importe quel traitement de texte, jamais la dernière ligne d'un bloc justifié. */
export type TextAlign = "left" | "center" | "right" | "justify";

/**
 * Une zone de texte tapée au clavier, posée sur la feuille — voir
 * view.ts:startTextCreation (outil "text", clic ou glissement) et
 * startTextEditing (reclic avec l'outil texte, ou double-clic avec un autre
 * outil, pour rouvrir l'édition d'une zone existante). Partage x/y/width/
 * height/rotation/locked avec ImageElement (même comportement générique de
 * déplacement/redimensionnement/rotation/verrouillage dans view.ts, sans code
 * dédié) et color/size avec ShapeElement (size est une taille de base, comme
 * Stroke.size/ShapeElement.size — voir render.ts:textFontSize pour sa
 * conversion en taille de police réelle).
 *
 * `width` fixe la largeur de retour à la ligne : un simple CLIC choisit un
 * texte qui épouse sa propre largeur (voir render.ts:measureTextBoxSize),
 * tandis qu'un CLIC-GLISSÉ fige `width` à la taille dessinée, comme une forme
 * — voir view.ts:finishTextBoxCreation, seul endroit qui distingue les deux.
 * `height`, elle, est TOUJOURS recalculée à chaque modification du texte
 * (voir render.ts:measureTextHeight), jamais ajustée manuellement par
 * l'utilisateur au-delà de ce que la saisie impose à une largeur donnée — un
 * redimensionnement manuel ultérieur (poignées de l'outil sélection) change
 * `width` comme n'importe quel élément, ce qui fait à son tour changer le
 * retour à la ligne au prochain rendu.
 */
export interface TextElement {
	id: string;
	type: "text";
	x: number;
	y: number;
	width: number;
	height: number;
	rotation: number;
	color: string;
	size: number;
	text: string;
	/** Absent équivaut à "left" (voir render.ts) — jamais réinitialisé à la relecture d'un .draw écrit par une version antérieure du plugin, qui n'avait pas ce champ. */
	align?: TextAlign;
	/** Verrouillé par l'outil sélection — même comportement que StrokeElement.locked/ImageElement.locked. */
	locked?: boolean;
}

/** Tout ce qu'une page peut contenir, dans l'ordre chronologique de création — voir DrawingPage.elements. */
export type DrawElement = StrokeElement | ImageElement | ShapeElement | TextElement;

/**
 * Une page d'un document .draw. Chaque page a ses propres dimensions, fond,
 * orientation, densité et éléments — totalement indépendants de ceux des
 * autres pages du même document (voir la fonctionnalité « pages multiples »).
 * Les coordonnées des éléments d'une page sont toujours relatives à CETTE
 * page (son coin haut-gauche est (0,0)), jamais au document entier : c'est
 * view.ts qui place chaque page dans un repère document partagé pour
 * l'affichage en défilement continu, sans jamais réécrire les coordonnées
 * stockées ici.
 */
export interface DrawingPage {
	width: number;
	height: number;
	background: BackgroundKind;
	orientation: Orientation;
	density: Density;
	elements: DrawElement[];
}

/**
 * Un document .draw : une suite ordonnée de pages, affichées en défilement
 * continu (voir view.ts). `version` gère les migrations :
 *  - 1 stockait `strokes: Stroke[]` au lieu d'`elements: DrawElement[]`, à
 *    plat (pas de notion de page) ;
 *  - 2 stockait `elements` à plat, toujours sans page (une feuille = une
 *    seule page implicite) ;
 *  - 3 introduit `pages: DrawingPage[]` — voir parse().
 */
export interface Drawing {
	version: 3;
	pages: DrawingPage[];
	/**
	 * Format intermédiaire, abandonné : un PDF importé référence aujourd'hui
	 * une pièce jointe (voir ImageElement.path, sa doc) plutôt qu'une entrée
	 * ici, un PDF volumineux encodé en base64 finissant, même une seule fois,
	 * par dépasser la longueur de chaîne maximale du moteur JS. Conservé
	 * uniquement pour lire les documents importés entre les deux correctifs :
	 * indexé par la clé référencée depuis ImageElement.path quand
	 * ImageElement.pdfPage est présent, chaque valeur étant le data URI
	 * complet d'UN PDF (voir imageCache.ts, qui le décode). Jamais peuplé par
	 * un nouvel import (voir main.ts:buildPdfPages) ; serialize() élimine les
	 * entrées qu'aucune page ne référence plus, pour qu'un .draw déjà passé
	 * par ce format intermédiaire finisse par en être entièrement débarrassé.
	 */
	pdfSources?: Record<string, string>;
}

/** Identifiant d'une entrée de `Drawing.pdfSources` — voir sa doc. Généré avec plus d'entropie que newStrokeId() : contrairement à un id d'élément (jamais comparé hors de son propre document), celui-ci sert de clé dans le cache d'images PARTAGÉ par tous les aperçus intégrés du coffre (voir imageCache.ts) — une collision y ferait afficher le PDF d'un autre fichier. */
export function newPdfSourceId(): string {
	return `pdf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Les formats de papier proposés dans le menu « Fond, densité, orientation, format » (voir view.ts:openPageMenu). */
export type PaperFormat = "a3" | "a4" | "a5" | "letter" | "legal";

/**
 * Dimensions de chaque format, EN PORTRAIT, à 96 dpi (1 mm = 96/25.4 px,
 * arrondi au pixel) — voir PAGE_WIDTH/PAGE_HEIGHT ci-dessous pour le format
 * par défaut. Convertir en paysage se fait en échangeant width et height,
 * comme pour toggleOrientation.
 */
export const PAPER_FORMAT_SIZES: Record<PaperFormat, { width: number; height: number }> = {
	a3: { width: 1123, height: 1587 }, // 297 × 420 mm
	a4: { width: 794, height: 1123 }, // 210 × 297 mm
	a5: { width: 559, height: 794 }, // 148 × 210 mm
	letter: { width: 816, height: 1056 }, // 8.5 × 11 po
	legal: { width: 816, height: 1344 }, // 8.5 × 14 po
};

/**
 * Le format dont les dimensions (en portrait OU en paysage) correspondent à
 * celles de `page` — pour cocher l'entrée active dans le menu (voir
 * view.ts:openPageMenu). `null` si aucun format connu ne correspond : une
 * page redimensionnée manuellement (fonctionnalité absente à ce jour, mais
 * le champ reste un simple nombre — voir DrawingPage), ou héritée d'un très
 * ancien fichier avec une taille personnalisée.
 */
export function matchPaperFormat(page: { width: number; height: number }): PaperFormat | null {
	for (const format of Object.keys(PAPER_FORMAT_SIZES) as PaperFormat[]) {
		const size = PAPER_FORMAT_SIZES[format];
		if (
			(page.width === size.width && page.height === size.height) ||
			(page.width === size.height && page.height === size.width)
		) {
			return format;
		}
	}
	return null;
}

/** A4 en portrait à 96 dpi : le format par défaut d'une nouvelle page, le plus familier pour des notes de cours. */
export const PAGE_WIDTH = PAPER_FORMAT_SIZES.a4.width;
export const PAGE_HEIGHT = PAPER_FORMAT_SIZES.a4.height;

/** Espacement vertical (unités du dessin, indépendant du zoom) entre deux pages consécutives à l'affichage — voir view.ts:layoutPages. Assez large pour qu'une page se distingue nettement de la suivante, sans gaspiller d'espace à l'écran. */
export const PAGE_GAP = 24;

export function createEmptyPage(
	background: BackgroundKind = "grid",
	density: Density = "normal",
	orientation: Orientation = "portrait"
): DrawingPage {
	return {
		width: orientation === "landscape" ? PAGE_HEIGHT : PAGE_WIDTH,
		height: orientation === "landscape" ? PAGE_WIDTH : PAGE_HEIGHT,
		background,
		orientation,
		density,
		elements: [],
	};
}

export function createEmptyDrawing(
	background: BackgroundKind = "grid",
	density: Density = "normal"
): Drawing {
	return {
		version: 3,
		pages: [createEmptyPage(background, density)],
	};
}

/**
 * Échange width et height et bascule l'orientation, en place, sur UNE page.
 * Les traits ne sont pas touchés : leurs coordonnées restent telles quelles,
 * on change le cadre, pas le contenu. Un trait peut donc se retrouver hors de
 * la page après une rotation — ce n'est pas une erreur, il redevient visible
 * si on bascule à nouveau l'orientation, ou si on le déplace.
 */
export function toggleOrientation(page: DrawingPage): void {
	const width = page.width;
	page.width = page.height;
	page.height = width;
	page.orientation = page.orientation === "portrait" ? "landscape" : "portrait";
}

export function newStrokeId(): string {
	return Math.random().toString(36).slice(2, 10);
}

/**
 * Élimine, avant d'écrire le fichier, les entrées de `drawing.pdfSources`
 * qu'aucune page ne référence plus (voir sa doc, Drawing) — jamais en
 * mutant `drawing` lui-même : l'historique d'annulation (History) garde ses
 * propres pages en mémoire tant que la vue reste ouverte, un retour arrière
 * après suppression d'un PDF doit encore trouver sa source dans le document
 * EN MÉMOIRE, seule la copie écrite sur disque est allégée.
 */
export function serialize(drawing: Drawing): string {
	if (!drawing.pdfSources) return JSON.stringify(drawing, null, 0);

	const referenced = new Set<string>();
	for (const page of drawing.pages) {
		for (const el of page.elements) {
			if (el.type === "image" && el.pdfPage != null && !el.path.startsWith("data:")) referenced.add(el.path);
		}
	}

	const pdfSources: Record<string, string> = {};
	for (const [id, dataUri] of Object.entries(drawing.pdfSources)) {
		if (referenced.has(id)) pdfSources[id] = dataUri;
	}
	const toWrite: Drawing =
		Object.keys(pdfSources).length > 0 ? { ...drawing, pdfSources } : { version: drawing.version, pages: drawing.pages };

	return JSON.stringify(toWrite, null, 0);
}

/**
 * Reconstruit une DrawingPage valide à partir de données potentiellement
 * incomplètes ou mal formées (fichier corrompu, ou l'ancien format à plat
 * version 1/2 — voir parse()). Migration silencieuse depuis la version 1 :
 * elle stockait `strokes: Stroke[]` au lieu d'`elements: DrawElement[]`, lus
 * ici et enveloppés dans `{ ...trait, type: "stroke" }`, dans le même ordre —
 * aucune perte, aucun trait modifié.
 */
function sanitizePage(data: Partial<DrawingPage> & { strokes?: Stroke[] }): DrawingPage {
	const orientation: Orientation = data.orientation === "landscape" ? "landscape" : "portrait";
	const defaultWidth = orientation === "landscape" ? PAGE_HEIGHT : PAGE_WIDTH;
	const defaultHeight = orientation === "landscape" ? PAGE_WIDTH : PAGE_HEIGHT;

	const elements: DrawElement[] = Array.isArray(data.elements)
		? data.elements
		: Array.isArray(data.strokes)
			? data.strokes.map((stroke) => ({ ...stroke, type: "stroke" as const }))
			: [];

	return {
		width: typeof data.width === "number" ? data.width : defaultWidth,
		height: typeof data.height === "number" ? data.height : defaultHeight,
		background: data.background ?? "grid",
		orientation,
		density: data.density ?? "normal",
		elements,
	};
}

/**
 * Lit un fichier .draw. Un fichier illisible ne doit jamais faire planter la vue
 * ni écraser silencieusement le travail de l'utilisateur : on renvoie un
 * document à une seule page vide et l'appelant décide quoi faire.
 *
 * Migration silencieuse depuis les versions 1 et 2 : les deux stockaient les
 * propriétés d'UNE SEULE page (width/height/background/orientation/density/
 * elements) directement à la racine du document, sans notion de pages
 * multiples. À la lecture, ce contenu devient un tableau `pages` d'un seul
 * élément, qui reprend exactement les valeurs actuelles de la feuille —
 * aucune perte, aucun élément modifié. Le fichier repasse en version 3 dès le
 * prochain enregistrement (`version` vaut toujours 3 dans l'objet renvoyé),
 * sans action explicite de l'utilisateur.
 */
/** `pdfSources` valide : un objet dont toutes les valeurs sont des chaînes (voir Drawing.pdfSources) — sinon ignoré silencieusement, comme le reste de sanitizePage() pour des données mal formées. */
function sanitizePdfSources(data: unknown): Record<string, string> | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
		if (typeof value === "string") result[key] = value;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

export function parse(raw: string): Drawing {
	if (!raw || !raw.trim()) return createEmptyDrawing();

	try {
		const data = JSON.parse(raw) as { pages?: unknown; pdfSources?: unknown } & Partial<DrawingPage> & {
			strokes?: Stroke[];
		};
		const pdfSources = sanitizePdfSources(data.pdfSources);

		if (Array.isArray(data.pages)) {
			const pages = (data.pages as Partial<DrawingPage>[]).map((p) => sanitizePage(p ?? {}));
			return { version: 3, pages: pages.length > 0 ? pages : [createEmptyPage()], ...(pdfSources && { pdfSources }) };
		}

		// Version 1 ou 2 : une seule page à plat, à la racine du document.
		return { version: 3, pages: [sanitizePage(data)], ...(pdfSources && { pdfSources }) };
	} catch {
		return createEmptyDrawing();
	}
}
