import {
	BackgroundKind,
	DrawElement,
	Density,
	DrawingPage,
	ImageElement,
	Orientation,
	ShapeElement,
	StrokeElement,
	toggleOrientation,
} from "./model";

/**
 * Une action décrit ce qui a changé sur UNE page, pas une copie du document
 * entier : un cahier de plusieurs dizaines de pages, chacune avec plusieurs
 * centaines de traits, coûterait cher à copier à chaque geste pour rien.
 * Chaque action est associée à l'index de la page qu'elle concerne (voir
 * History, HistoryEntry) : annuler/rétablir ne touche jamais qu'à cette
 * page précise, jamais aux autres.
 *
 * "erase" est le résultat d'un geste de gomme par zone : un ou plusieurs
 * éléments d'origine disparaissent, remplacés par ce qui a survécu au
 * passage de la gomme. Générique (`DrawElement`), pas limité aux traits :
 * un trait touché devient des traits fragments (voir render.ts:eraseZone),
 * une ligne/flèche des lignes/flèches plus courtes, un rectangle/ellipse
 * partiellement effacé devient des traits suivant ce qui reste de son
 * contour (voir view.ts:eraseZoneAt — une image, elle, n'est jamais
 * concernée, la gomme par zone ne la touche jamais). "add" (le trait en
 * cours de tracé qui vient de se terminer), lui, ne concerne toujours QUE
 * des traits, qui en sont l'unique origine.
 *
 * "addImage" est le pendant pour une image insérée (coller, glisser-déposer,
 * sélecteur de fichier — voir view.ts). Son inverse retire seulement
 * l'élément de `page.elements` : le fichier écrit dans le coffre n'est
 * JAMAIS supprimé par un undo, seule sa présence sur la feuille est annulée.
 *
 * "addShape" est le pendant pour une forme prédéfinie tracée avec la palette
 * de formes (rectangle, ellipse, ligne, flèche — voir ShapeElement,
 * model.ts) : rien à préserver hors du document contrairement à une image,
 * son inverse retire simplement l'élément.
 *
 * "remove" est générique (trait OU image) : la gomme par trait entier ET la
 * suppression d'une sélection (Suppr) partagent la même forme — retirer des
 * éléments, les réinsérer à leur index d'origine sur un undo.
 *
 * "transform" couvre tout ce que l'outil sélection applique à un ensemble
 * d'éléments existants sans changer leurs identifiants : déplacement, mise à
 * l'échelle, rotation, mais aussi changement de couleur/épaisseur — dans
 * tous les cas, un élément est remplacé par une version modifiée de
 * lui-même, appariée par id. "reorder" est distinct : lui ne change aucun
 * contenu, seulement l'ordre d'empilement (mise au premier/arrière-plan),
 * donc un simple instantané avant/après du tableau complet suffit.
 *
 * "addMany" couvre coller et dupliquer une sélection : plusieurs éléments
 * ajoutés d'un coup, retirés ensemble par un undo.
 *
 * "background", "density", "orientation" et "format" sont des propriétés de
 * la page (pas des traits) : elles vivent au même niveau que `elements` dans
 * `DrawingPage`, donc les fonctions ci-dessous opèrent sur la `DrawingPage`
 * entière plutôt que sur son seul tableau d'éléments. "format" change
 * width/height directement (voir view.ts:setFormat) — contrairement à
 * "orientation", qui les échange sans changer le format, un changement de
 * format respecte l'orientation courante de la page plutôt que de la
 * réinitialiser.
 *
 * Ce qui traverse la frontière entre deux pages (déplacer une sélection
 * d'une feuille à l'autre avec l'outil sélection, voir
 * DrawView.commitTransform) N'EST PAS une HistoryAction : une action ne
 * concerne toujours qu'UNE SEULE page (voir HistoryEntry ci-dessous), alors
 * qu'un tel déplacement en retire d'une page ET en ajoute à une autre dans
 * le même geste. Voir CrossPageMove, distinct, undoable via
 * applyMovePagesForward/Inverse.
 */
export type HistoryAction =
	| { type: "add"; stroke: StrokeElement }
	| { type: "addImage"; element: ImageElement }
	| { type: "addShape"; element: ShapeElement }
	| { type: "addMany"; elements: DrawElement[] }
	| { type: "remove"; removed: { index: number; element: DrawElement }[] }
	| { type: "erase"; removed: { index: number; element: DrawElement }[]; added: DrawElement[] }
	| { type: "transform"; before: DrawElement[]; after: DrawElement[] }
	| { type: "reorder"; before: DrawElement[]; after: DrawElement[] }
	| { type: "background"; from: BackgroundKind; to: BackgroundKind }
	| { type: "density"; from: Density; to: Density }
	| { type: "orientation"; from: Orientation; to: Orientation }
	| { type: "format"; from: { width: number; height: number }; to: { width: number; height: number } };

/**
 * Une sélection déplacée d'une page à l'autre (voir DrawView.commitTransform,
 * updateTransform — plus de mur de page pour un déplacement, contrairement à
 * un redimensionnement ou une rotation) : chaque élément déplacé garde son
 * identité (même id), mais `before`/`after` sont ses coordonnées dans le
 * repère de `fromPage`, respectivement `toPage` — pas la même valeur brute,
 * puisque chaque page a son propre repère local. `index` : sa position
 * d'origine dans `fromPage.elements`, pour qu'un undo l'y réinsère
 * exactement (voir applyMovePagesInverse).
 */
export interface CrossPageMove {
	fromPage: number;
	toPage: number;
	moved: { index: number; before: DrawElement; after: DrawElement }[];
}

/**
 * Une entrée de l'historique : soit une HistoryAction ordinaire sur UNE
 * page, soit un CrossPageMove entre deux. undo()/redo() renvoient ce type
 * générique — à l'appelant (DrawView.applyHistoryEntry) de distinguer via
 * `kind` plutôt que de supposer qu'une seule page est concernée.
 */
export type HistoryEntry =
	| { kind: "action"; pageIndex: number; action: HistoryAction }
	| { kind: "movePages"; move: CrossPageMove };

function removeByIds(elements: DrawElement[], ids: Set<string>): void {
	for (let i = elements.length - 1; i >= 0; i--) {
		if (ids.has(elements[i].id)) elements.splice(i, 1);
	}
}

function reinsertAtOriginalIndices(
	elements: DrawElement[],
	removed: { index: number; element: DrawElement }[]
): void {
	const ordered = [...removed].sort((a, b) => a.index - b.index);
	for (const { index, element } of ordered) elements.splice(index, 0, element);
}

/** Remplace chaque élément de `from` par son homologue de `to` (apparié par id), à sa position actuelle dans le tableau — jamais un splice-out/splice-in qui déplacerait l'élément dans l'ordre d'empilement. */
function replaceByPairs(elements: DrawElement[], from: DrawElement[], to: DrawElement[]): void {
	const replacement = new Map(from.map((el, i) => [el.id, to[i]]));
	for (let i = 0; i < elements.length; i++) {
		const next = replacement.get(elements[i].id);
		if (next) elements[i] = next;
	}
}

/** Rejoue une action vers l'avant (refaire), sur la page qu'elle concerne. */
export function applyForward(page: DrawingPage, action: HistoryAction): void {
	switch (action.type) {
		case "add":
			page.elements.push(action.stroke);
			return;
		case "addImage":
			page.elements.push(action.element);
			return;
		case "addShape":
			page.elements.push(action.element);
			return;
		case "addMany":
			page.elements.push(...action.elements);
			return;
		case "remove":
			removeByIds(page.elements, new Set(action.removed.map((r) => r.element.id)));
			return;
		case "erase":
			removeByIds(page.elements, new Set(action.removed.map((r) => r.element.id)));
			page.elements.push(...action.added);
			return;
		case "transform":
			replaceByPairs(page.elements, action.before, action.after);
			return;
		case "reorder":
			page.elements = [...action.after];
			return;
		case "background":
			page.background = action.to;
			return;
		case "density":
			page.density = action.to;
			return;
		case "orientation":
			// Un seul aller-retour possible entre deux états : basculer suffit,
			// pas besoin de lire action.to (voir toggleOrientation, model.ts).
			toggleOrientation(page);
			return;
		case "format":
			page.width = action.to.width;
			page.height = action.to.height;
			return;
	}
}

/**
 * Rejoue l'inverse d'une action (annuler), sur la page qu'elle concerne. Pour
 * une suppression multiple, les traits sont réinsérés dans l'ordre croissant
 * de leur index d'origine : c'est ce qui permet de retomber exactement sur
 * l'arrangement d'avant la suppression, y compris pour les traits de même
 * outil dont l'ordre d'empilement dépend de leur position dans le tableau.
 */
export function applyInverse(page: DrawingPage, action: HistoryAction): void {
	switch (action.type) {
		case "add": {
			const i = page.elements.findIndex((el) => el.id === action.stroke.id);
			if (i !== -1) page.elements.splice(i, 1);
			return;
		}
		case "addImage": {
			// Retire uniquement l'élément de la feuille : le fichier reste dans le
			// coffre (voir la doc de HistoryAction, ci-dessus) — jamais de
			// suppression de fichier déclenchée par un undo.
			const i = page.elements.findIndex((el) => el.id === action.element.id);
			if (i !== -1) page.elements.splice(i, 1);
			return;
		}
		case "addShape": {
			const i = page.elements.findIndex((el) => el.id === action.element.id);
			if (i !== -1) page.elements.splice(i, 1);
			return;
		}
		case "addMany":
			removeByIds(page.elements, new Set(action.elements.map((el) => el.id)));
			return;
		case "remove":
			reinsertAtOriginalIndices(page.elements, action.removed);
			return;
		case "erase":
			removeByIds(page.elements, new Set(action.added.map((s) => s.id)));
			reinsertAtOriginalIndices(page.elements, action.removed);
			return;
		case "transform":
			replaceByPairs(page.elements, action.after, action.before);
			return;
		case "reorder":
			page.elements = [...action.before];
			return;
		case "background":
			page.background = action.from;
			return;
		case "density":
			page.density = action.from;
			return;
		case "orientation":
			toggleOrientation(page);
			return;
		case "format":
			page.width = action.from.width;
			page.height = action.from.height;
			return;
	}
}

/** Rejoue vers l'avant (refaire) un déplacement entre pages : retire les éléments de `fromPage`, les ajoute (coordonnées déjà exprimées dans son repère, voir CrossPageMove) à `toPage`. */
export function applyMovePagesForward(fromPage: DrawingPage, toPage: DrawingPage, move: CrossPageMove): void {
	const ids = new Set(move.moved.map((m) => m.after.id));
	fromPage.elements = fromPage.elements.filter((el) => !ids.has(el.id));
	toPage.elements.push(...move.moved.map((m) => m.after));
}

/** Rejoue l'inverse (annuler) d'un déplacement entre pages : retire de `toPage`, réinsère dans `fromPage` à l'index d'origine de chaque élément (voir CrossPageMove.moved), dans l'ordre croissant — même principe que reinsertAtOriginalIndices. */
export function applyMovePagesInverse(fromPage: DrawingPage, toPage: DrawingPage, move: CrossPageMove): void {
	const ids = new Set(move.moved.map((m) => m.before.id));
	toPage.elements = toPage.elements.filter((el) => !ids.has(el.id));
	const ordered = [...move.moved].sort((a, b) => a.index - b.index);
	for (const { index, before } of ordered) fromPage.elements.splice(index, 0, before);
}

/** Pile d'annulation/rétablissement par entrées (voir HistoryEntry), chacune associée à la ou aux pages qu'elle concerne — annuler ou rétablir ne touche jamais qu'à ces pages précises, jamais aux autres pages du document. */
export class History {
	private undoStack: HistoryEntry[] = [];
	private redoStack: HistoryEntry[] = [];

	/** Enregistre une action déjà appliquée à `page.elements`/propriétés de la page d'index `pageIndex`. Vide la pile de rétablissement. */
	push(pageIndex: number, action: HistoryAction): void {
		this.undoStack.push({ kind: "action", pageIndex, action });
		this.redoStack = [];
	}

	/** Enregistre un déplacement entre pages déjà appliqué (voir DrawView.commitTransform). Vide la pile de rétablissement. */
	pushMove(move: CrossPageMove): void {
		this.undoStack.push({ kind: "movePages", move });
		this.redoStack = [];
	}

	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	/** Dépile la dernière entrée à annuler ; à l'appelant de l'appliquer à l'envers aux pages concernées. */
	undo(): HistoryEntry | null {
		const entry = this.undoStack.pop();
		if (!entry) return null;
		this.redoStack.push(entry);
		return entry;
	}

	/** Dépile la dernière entrée à rétablir ; à l'appelant de la réappliquer aux pages concernées. */
	redo(): HistoryEntry | null {
		const entry = this.redoStack.pop();
		if (!entry) return null;
		this.undoStack.push(entry);
		return entry;
	}

	/**
	 * Retire de la pile toute entrée concernant SEULEMENT la page `pageIndex`
	 * (celle-ci va disparaître, voir view.ts:deletePage) — pour un
	 * CrossPageMove, dès que `fromPage` OU `toPage` est la page supprimée,
	 * puisqu'un undo/redo partiel (une moitié du déplacement introuvable)
	 * n'aurait aucun sens. Décale ensuite l'index de toute page suivante
	 * d'un cran vers le bas — sans ça, undo/redo appliquerait une entrée à
	 * la mauvaise page après une suppression, ou à une page qui n'existe plus.
	 */
	removePage(pageIndex: number): void {
		const shiftDown = (i: number): number => (i > pageIndex ? i - 1 : i);
		const shift = (entries: HistoryEntry[]): HistoryEntry[] =>
			entries
				.filter((e) =>
					e.kind === "action"
						? e.pageIndex !== pageIndex
						: e.move.fromPage !== pageIndex && e.move.toPage !== pageIndex
				)
				.map((e) =>
					e.kind === "action"
						? { kind: "action" as const, pageIndex: shiftDown(e.pageIndex), action: e.action }
						: {
								kind: "movePages" as const,
								move: { ...e.move, fromPage: shiftDown(e.move.fromPage), toPage: shiftDown(e.move.toPage) },
						  }
				);
		this.undoStack = shift(this.undoStack);
		this.redoStack = shift(this.redoStack);
	}

	/**
	 * Pendant de removePage() pour une insertion (voir view.ts:insertPageAt,
	 * qui peut désormais insérer une page ailleurs qu'en toute fin de
	 * document) : décale vers le haut l'index de toute page à partir de
	 * `pageIndex` (celle-ci comprise, puisqu'elle glisse pour laisser la
	 * place à la nouvelle page), sans jamais retirer d'entrée — une
	 * insertion ne perd aucun historique, contrairement à une suppression.
	 */
	insertPage(pageIndex: number): void {
		const shiftUp = (i: number): number => (i >= pageIndex ? i + 1 : i);
		const shift = (entries: HistoryEntry[]): HistoryEntry[] =>
			entries.map((e) =>
				e.kind === "action"
					? { kind: "action" as const, pageIndex: shiftUp(e.pageIndex), action: e.action }
					: {
							kind: "movePages" as const,
							move: { ...e.move, fromPage: shiftUp(e.move.fromPage), toPage: shiftUp(e.move.toPage) },
					  }
			);
		this.undoStack = shift(this.undoStack);
		this.redoStack = shift(this.redoStack);
	}

	/**
	 * Pendant de removePage()/insertPage() pour un réarrangement (voir
	 * view.ts:movePageTo) : décale les entrées comme le ferait
	 * `pages.splice(from, 1)` suivi de `pages.splice(to, 0, page)` — jamais
	 * de perte, contrairement à removePage() : la page déplacée garde tout
	 * son historique, juste réindexé vers sa nouvelle position (voir
	 * remapPageIndex, la même formule que view.ts applique à
	 * selectedPageIndex/focusedPageIndex, pour ne pas la dupliquer).
	 */
	movePage(from: number, to: number): void {
		if (from === to) return;
		const shift = (entries: HistoryEntry[]): HistoryEntry[] =>
			entries.map((e) =>
				e.kind === "action"
					? { kind: "action" as const, pageIndex: remapPageIndex(e.pageIndex, from, to), action: e.action }
					: {
							kind: "movePages" as const,
							move: {
								...e.move,
								fromPage: remapPageIndex(e.move.fromPage, from, to),
								toPage: remapPageIndex(e.move.toPage, from, to),
							},
					  }
			);
		this.undoStack = shift(this.undoStack);
		this.redoStack = shift(this.redoStack);
	}
}

/**
 * Où atterrit l'index `i` après avoir déplacé la page `from` à la position
 * `to` par `pages.splice(from, 1)` puis `pages.splice(to, 0, page)` — exportée
 * pour que view.ts applique exactement la même règle à selectedPageIndex et
 * focusedPageIndex que celle utilisée ici pour l'historique (voir
 * History.movePage). `i === from` atterrit sur `to` ; entre les deux bornes,
 * tout se décale d'un cran dans le sens opposé au déplacement ; en dehors,
 * rien ne bouge.
 */
export function remapPageIndex(i: number, from: number, to: number): number {
	if (i === from) return to;
	if (from < to) return i > from && i <= to ? i - 1 : i;
	return i >= to && i < from ? i + 1 : i;
}
