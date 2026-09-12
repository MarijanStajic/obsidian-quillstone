import { jsPDF } from "jspdf";

/**
 * Assemblage d'un PDF à partir de pages déjà rendues en bitmap, pour la
 * fonctionnalité « exporter en PDF » — direction inverse de pdf.ts (qui LIT
 * un PDF). Comme render.ts/model.ts, ce module ne connaît pas Obsidian : à
 * l'appelant (view.ts:exportToPdf) de rendre chaque page (via renderScene,
 * en attendant que ses images soient prêtes) et d'écrire le résultat dans le
 * coffre.
 */

/** 1 point PDF = 1/72 pouce ; nos pages .draw sont exprimées à 96 dpi (voir model.ts, PAGE_WIDTH/PAGE_HEIGHT). Sert à convertir les dimensions logiques d'une page en points PDF. */
const POINTS_PER_LOGICAL_UNIT = 72 / 96;

export interface ExportPage {
	/** Déjà peint via renderScene (voir view.ts:exportToPdf) — sa résolution pixel peut dépasser width/height (voir EXPORT_RASTER_SCALE) pour rester net à l'impression, jsPDF le remet à l'échelle de la page. */
	canvas: HTMLCanvasElement;
	/** Dimensions LOGIQUES de la page (96 dpi, voir DrawingPage.width/height) — pas celles du canvas. */
	width: number;
	height: number;
}

/** Construit un PDF d'une page par élément de `pages`, dans l'ordre, chacune à sa propre taille (voir jsPDF.addPage) — un cahier de pages portrait et paysage mélangées reste fidèle à l'affichage, page par page. */
export function buildPdfFromPages(pages: ExportPage[]): Blob {
	if (pages.length === 0) throw new Error("No page to export.");

	let doc: jsPDF | null = null;
	for (const page of pages) {
		const widthPt = page.width * POINTS_PER_LOGICAL_UNIT;
		const heightPt = page.height * POINTS_PER_LOGICAL_UNIT;
		const orientation = widthPt > heightPt ? "l" : "p";

		if (!doc) {
			doc = new jsPDF({ unit: "pt", format: [widthPt, heightPt], orientation, compress: true });
		} else {
			doc.addPage([widthPt, heightPt], orientation);
		}
		// JPEG, pas PNG : jsPDF assemble tout le PDF en une seule string en
		// mémoire (voir buildDocument) — un cahier de plusieurs dizaines de
		// pages en PNG non compressé (surtout avec un fond scanné/PDF importé)
		// dépasse la longueur max d'une string JS. jsPDF avale alors l'erreur
		// en interne (son wrapper d'API l'attrape et logue, sans la
		// propager) et `.output()` renvoie undefined au lieu de lancer —
		// d'où la vérification explicite ci-dessous plutôt que de laisser
		// l'appelant échouer plus loin avec un message confus.
		doc.addImage(page.canvas, "JPEG", 0, 0, widthPt, heightPt);
	}

	const blob = doc!.output("blob");
	if (!(blob instanceof Blob)) {
		throw new Error("PDF generation failed: the document may be too large to export.");
	}
	return blob;
}
