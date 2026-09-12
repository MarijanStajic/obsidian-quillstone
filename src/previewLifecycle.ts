import { MarkdownRenderChild } from "obsidian";
import { DrawPreviewManager } from "./preview";

/**
 * Désinscrit un aperçu intégré du suivi « rafraîchir à la modification »
 * (DrawPreviewManager.untrack) quand Obsidian retire son conteneur du DOM —
 * en mode Lecture, ça arrive à chaque re-rendu de la section (édition,
 * retour en lecture, fermeture de la note). Sans ce nettoyage, le
 * gestionnaire garderait indéfiniment des conteneurs qui n'affichent plus
 * rien à l'écran.
 */
export class DrawEmbedLifecycle extends MarkdownRenderChild {
	constructor(containerEl: HTMLElement, private preview: DrawPreviewManager, private path: string) {
		super(containerEl);
	}

	onunload(): void {
		this.preview.untrack(this.path, this.containerEl);
	}
}
