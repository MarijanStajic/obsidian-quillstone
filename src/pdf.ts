import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PdfLink } from "./model";
import pdfWorkerSource from "virtual:pdf-worker-source";

/**
 * Lecture et rendu de PDF, pour la fonctionnalité « importer un PDF ». Comme
 * render.ts/model.ts, ce module ne connaît pas Obsidian : c'est l'appelant
 * (main.ts:QuillStonePlugin.buildPdfPages, imageCache.ts) qui fournit le
 * chemin du worker pdf.js (dépend du dossier du plugin dans le coffre),
 * fournit les octets du PDF (décodés depuis le data URI qui l'encode, voir
 * ImageElement.path, model.ts — aucun fichier .pdf séparé n'existe dans le
 * coffre), et décide où mettre en cache le résultat.
 *
 * Le PDF entier n'est encodé qu'une seule fois à l'import (voir
 * main.ts:buildPdfPages, appelée aussi bien pour une nouvelle feuille que
 * pour une feuille déjà ouverte) — jamais un PNG par page : chaque page de
 * la feuille référence ce même data URI via ImageElement.path, avec
 * ImageElement.pdfPage pour dire laquelle. Le bitmap de chaque page est
 * rendu à la demande (voir imageCache.ts), pas rasterisé ni stocké à
 * l'avance : demander sa taille (getPdfPageSize, appelé une fois par page à
 * l'import pour dimensionner la DrawingPage) ne coûte qu'une lecture de
 * métadonnées, jamais un rendu.
 */

/** 1 point PDF = 1/72 pouce ; nos pages .draw sont exprimées à 96 dpi (voir model.ts, PAGE_WIDTH/PAGE_HEIGHT). Sert à convertir les dimensions d'une page PDF en unités du dessin. */
const LOGICAL_DPI = 96;

/** La référence d'objet PDF que `getPageIndex` attend (voir resolveDestination) — déduite de sa signature plutôt qu'importée : pdf.js ne réexporte pas ce type (`RefProxy`) depuis la racine du paquet. */
type PdfRef = Parameters<PDFDocumentProxy["getPageIndex"]>[0];

/** Résolution de rendu du bitmap affiché : plus élevée que LOGICAL_DPI pour rester net après un zoom raisonnable sur la page importée. */
const RASTER_DPI = 200;

let workerConfigured = false;

/**
 * À appeler une fois avant tout getDocument(). Le code du Worker pdf.js est
 * embarqué dans main.js sous forme de chaîne (voir esbuild.config.mjs,
 * virtual:pdf-worker-source) plutôt que livré comme fichier séparé : Obsidian
 * ne télécharge que main.js/manifest.json/styles.css depuis une release,
 * donc un pdf.worker.js à part ne serait jamais présent chez un utilisateur
 * ayant installé le plugin normalement. On le matérialise ici en Blob URL,
 * jamais révoquée : le Worker doit rester joignable pour toute la durée de
 * vie du plugin.
 */
export function configurePdfWorker(): void {
	if (workerConfigured) return;
	const blob = new Blob([pdfWorkerSource], { type: "text/javascript" });
	pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
	workerConfigured = true;
}

/** Analyse un PDF déjà lu en mémoire — à l'appelant de garder la référence renvoyée (voir imageCache.ts) et de la libérer via `.destroy()` quand elle n'est plus utile. */
export function loadPdfDocument(data: ArrayBuffer): Promise<PDFDocumentProxy> {
	return pdfjsLib.getDocument({ data }).promise;
}

/** Dimensions d'une page (1-indexée comme pdf.js), en unités du dessin (96 dpi) — voir DrawingPage.width/height. Ne rend rien : juste la géométrie de la page, bon marché même pour un PDF de centaines de pages. */
export async function getPdfPageSize(doc: PDFDocumentProxy, pageNumber: number): Promise<{ width: number; height: number }> {
	const page = await doc.getPage(pageNumber);
	const viewport = page.getViewport({ scale: LOGICAL_DPI / 72 });
	return { width: Math.round(viewport.width), height: Math.round(viewport.height) };
}

/**
 * Rend une page en bitmap, à la résolution d'affichage (RASTER_DPI) — jamais
 * mis en cache ici (voir imageCache.ts, seul appelant : c'est lui qui décide
 * combien de temps garder le résultat en mémoire).
 */
export async function renderPdfPageToCanvas(doc: PDFDocumentProxy, pageNumber: number): Promise<HTMLCanvasElement> {
	const page = await doc.getPage(pageNumber);
	const viewport = page.getViewport({ scale: RASTER_DPI / 72 });

	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(viewport.width));
	canvas.height = Math.max(1, Math.round(viewport.height));
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Canvas 2D unavailable");

	await page.render({ canvasContext: ctx, viewport }).promise;
	return canvas;
}

/** Les seuls schémas d'URL qu'un lien externe de PDF a le droit d'ouvrir (voir sanitizeLinkUrl) : un `file:`, un `javascript:` ou tout autre schéma exotique venant d'un PDF dont on ne sait rien n'est jamais conservé. */
const SAFE_LINK_PROTOCOLS = ["http:", "https:", "mailto:"];

/** Arrondi des fractions stockées dans un PdfLink : 5 décimales valent moins d'un centième de pixel sur une page A4, pour une écriture JSON bien plus courte que celle d'un flottant brut (un PDF peut porter des centaines de liens). */
function round5(value: number): number {
	return Math.round(value * 1e5) / 1e5;
}

/** `raw` si c'est une URL absolue à un schéma autorisé (voir SAFE_LINK_PROTOCOLS), `undefined` sinon — y compris pour une URL relative ou mal formée, qu'on ne tente jamais de réparer. */
function sanitizeLinkUrl(raw: unknown): string | undefined {
	if (typeof raw !== "string" || !raw) return undefined;
	try {
		const parsed = new URL(raw);
		return SAFE_LINK_PROTOCOLS.includes(parsed.protocol) ? parsed.href : undefined;
	} catch {
		return undefined;
	}
}

/**
 * L'ordonnée visée (repère PDF, donc mesurée depuis le BAS de la page) d'une
 * destination explicite pdf.js — `[page, { name }, ...paramètres]`, où les
 * paramètres dépendent du mode d'affichage demandé : "XYZ" (coin haut-gauche
 * + zoom), "FitH"/"FitBH" (ajuster la largeur à une hauteur donnée), "FitR"
 * (ajuster un rectangle). `null` pour les modes qui ne désignent que la page
 * entière ("Fit", "FitB", "FitV", "FitBV"), ou quand le paramètre attendu est
 * absent (il peut valoir `null` dans le PDF lui-même, ce qui signifie
 * « inchangé » — soit rien de précis à viser ici).
 */
function destinationTop(explicit: unknown[]): number | null {
	const name = (explicit[1] as { name?: string } | undefined)?.name;
	const at = (index: number): number | null => (typeof explicit[index] === "number" ? (explicit[index] as number) : null);
	switch (name) {
		case "XYZ":
			return at(3);
		case "FitH":
		case "FitBH":
			return at(2);
		case "FitR":
			return at(5);
		default:
			return null;
	}
}

/**
 * Où mène un lien interne : son numéro de page (1-indexé, comme pdf.js) et,
 * si la destination le précise, la hauteur visée dedans en fraction de la
 * page (voir PdfLink.targetY). `null` si la destination est introuvable ou
 * illisible — un lien nommé dont le nom n'existe pas dans le PDF, un renvoi
 * vers un document externe ("GoToR"), une page hors limites : autant de cas
 * où mieux vaut ne pas créer de lien du tout qu'en créer un qui n'aboutit
 * nulle part.
 *
 * `dest` arrive soit déjà explicite (un tableau), soit comme un NOM de
 * destination (une chaîne) à résoudre via le document — c'est pdf.js qui
 * choisit, selon la façon dont le PDF a écrit son lien. Dans les deux cas, la
 * résolution a lieu ICI, à l'import, pour que le .draw ne garde qu'un simple
 * numéro de page : plus rien à relire dans le PDF au moment du clic.
 */
async function resolveDestination(
	doc: PDFDocumentProxy,
	dest: unknown
): Promise<{ pageNumber: number; targetY?: number } | null> {
	let explicit: unknown[] | null = null;
	try {
		explicit = Array.isArray(dest) ? dest : typeof dest === "string" ? await doc.getDestination(dest) : null;
	} catch {
		return null;
	}
	if (!explicit || explicit.length === 0) return null;

	const ref = explicit[0];
	let pageIndex: number | null = null;
	if (typeof ref === "number") {
		// Destination écrite directement comme un index de page (0-indexé),
		// plutôt que comme une référence d'objet PDF à résoudre.
		pageIndex = ref;
	} else if (ref !== null && typeof ref === "object" && typeof (ref as PdfRef).num === "number") {
		try {
			pageIndex = await doc.getPageIndex(ref as PdfRef);
		} catch {
			return null;
		}
	}
	if (pageIndex === null || pageIndex < 0 || pageIndex >= doc.numPages) return null;

	const pageNumber = pageIndex + 1;
	const top = destinationTop(explicit);
	if (top === null) return { pageNumber };

	// La hauteur visée est convertie en fraction de la page de DESTINATION
	// (pas celle du lien) : c'est elle qu'on fera défiler. convertToViewportPoint
	// applique au passage son éventuelle rotation, comme pour le rectangle du
	// lien lui-même.
	const page = await doc.getPage(pageNumber);
	const viewport = page.getViewport({ scale: 1 });
	const [, y] = viewport.convertToViewportPoint(0, top);
	return { pageNumber, targetY: round5(Math.min(1, Math.max(0, y / viewport.height))) };
}

/**
 * Les liens cliquables d'une page, lus dans ses annotations — appelé une
 * seule fois par page à l'import (voir main.ts:buildPdfPages), jamais au
 * moment d'un clic : le résultat est stocké dans le .draw (voir
 * ImageElement.pdfLinks, model.ts). Ne rend rien, comme getPdfPageSize :
 * seules les annotations de la page sont lues, pas son contenu graphique.
 *
 * Les rectangles renvoyés sont en FRACTION de la page (voir PdfLink), ce qui
 * les rend indépendants de la résolution de rendu (RASTER_DPI) comme de
 * l'échelle logique (LOGICAL_DPI) : c'est pourquoi la vue d'affichage est
 * prise ici à `scale: 1` — elle ne sert qu'à appliquer la rotation de la page
 * et à retourner l'axe vertical du repère PDF (origine en bas) vers celui du
 * dessin (origine en haut).
 */
export async function getPdfPageLinks(doc: PDFDocumentProxy, pageNumber: number): Promise<PdfLink[]> {
	const page = await doc.getPage(pageNumber);
	const viewport = page.getViewport({ scale: 1 });

	let annotations: unknown[];
	try {
		annotations = await page.getAnnotations({ intent: "display" });
	} catch {
		// Annotations illisibles (PDF partiellement corrompu) : la page
		// s'importe quand même, simplement sans ses liens — jamais un import
		// entier qui échoue à cause d'une table d'annotations abîmée.
		return [];
	}

	const links: PdfLink[] = [];
	for (const annotation of annotations) {
		const a = annotation as { subtype?: string; rect?: unknown; url?: unknown; unsafeUrl?: unknown; dest?: unknown };
		if (a.subtype !== "Link" || !Array.isArray(a.rect) || a.rect.length < 4) continue;

		const url = sanitizeLinkUrl(a.url ?? a.unsafeUrl);
		const target = url ? null : await resolveDestination(doc, a.dest);
		// Ni adresse exploitable ni destination interne : un lien d'un autre
		// genre (exécuter un fichier, ouvrir un autre document, action nommée
		// « page suivante »...), volontairement ignoré plutôt que deviné.
		if (!url && !target) continue;

		const [vx1, vy1, vx2, vy2] = viewport.convertToViewportRectangle(a.rect as number[]);
		const width = Math.abs(vx2 - vx1) / viewport.width;
		const height = Math.abs(vy2 - vy1) / viewport.height;
		if (!(width > 0) || !(height > 0)) continue; // rectangle vide (ou dimensions non numériques) : rien à cliquer

		links.push({
			x: round5(Math.min(vx1, vx2) / viewport.width),
			y: round5(Math.min(vy1, vy2) / viewport.height),
			width: round5(width),
			height: round5(height),
			...(url ? { url } : { targetPdfPage: target!.pageNumber, ...(target!.targetY !== undefined && { targetY: target!.targetY }) }),
		});
	}
	return links;
}
