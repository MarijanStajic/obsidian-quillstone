/**
 * Extraction des images insérées sur une feuille (collage ou sélecteur de
 * fichier) — voir view.ts:insertImageFromBlob, qui les encode ensuite en data
 * URI (ImageElement.path, model.ts) plutôt que d'écrire un fichier séparé
 * dans le coffre : ce module ne connaît donc pas Obsidian, comme
 * model.ts/render.ts.
 */

/** Formats acceptés à l'insertion — voir la fonctionnalité « images collées sur la feuille ». */
const EXTENSION_BY_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
};

export function extensionForMime(mime: string): string | null {
	return EXTENSION_BY_MIME[mime] ?? null;
}

/** Dimensions naturelles d'une image, décodée hors DOM (aucun élément inséré nulle part). */
export function readImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(blob);
		const img = new Image();
		img.onload = () => {
			URL.revokeObjectURL(url);
			resolve({ width: img.naturalWidth, height: img.naturalHeight });
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error("Image unreadable"));
		};
		img.src = url;
	});
}

/** Encode `blob` en data URI (`data:<mime>;base64,...`) — voir ImageElement.path, model.ts : c'est ce qui permet à une image collée de vivre entièrement dans le .draw, sans fichier séparé dans le coffre. */
export function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
		reader.readAsDataURL(blob);
	});
}
