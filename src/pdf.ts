import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";

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

/** Résolution de rendu du bitmap affiché : plus élevée que LOGICAL_DPI pour rester net après un zoom raisonnable sur la page importée. */
const RASTER_DPI = 200;

let workerConfigured = false;

/** À appeler une fois avant tout getDocument() — voir esbuild.config.mjs pour la provenance de pdf.worker.js, bundlé séparément de main.js. */
export function configurePdfWorker(workerSrc: string): void {
	if (workerConfigured) return;
	pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
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
	if (!ctx) throw new Error("Canvas 2D indisponible");

	await page.render({ canvasContext: ctx, viewport }).promise;
	return canvas;
}
