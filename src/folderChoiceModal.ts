import { App, Modal, Setting, TFolder } from "obsidian";

/**
 * Demande où créer une nouvelle feuille de dessin : le dossier « actuel »
 * proposé en premier (celui de la note active, ou la racine du coffre s'il
 * n'y en a pas), ou un autre dossier du coffre choisi dans une liste
 * filtrable. Utilisé par toutes les entrées qui créent un fichier .draw
 * (insertion d'une feuille blanche, import de PDF, bouton du ruban) pour que
 * le comportement soit identique partout. Renvoie `null` si l'utilisateur
 * annule à n'importe quelle étape.
 */
export function chooseDrawingFolder(app: App, currentFolder: string): Promise<string | null> {
	return new Promise((resolve) => {
		new FolderChoiceModal(app, currentFolder, resolve).open();
	});
}

/**
 * UNE SEULE modale (jamais une seconde ouverte par-dessus après avoir fermé
 * celle-ci) : les deux écrans — le choix initial, puis la liste filtrable —
 * ne sont que deux rendus successifs de contentEl dans la même instance
 * (voir renderChoice/renderPicker). Une version précédente enchaînait deux
 * Modal distinctes (close() puis new FuzzySuggestModal().open()) : la liste
 * s'affichait mais aucun clic dessus n'aboutissait, un arrière-plan de
 * modale résiduel semblant intercepter les clics. Rester sur une seule
 * instance, avec de simples écouteurs "click" posés à la main, évite le
 * problème entièrement plutôt que de le contourner.
 */
class FolderChoiceModal extends Modal {
	/** Empêche onClose() de résoudre `null` une seconde fois après un choix déjà résolu. */
	private resolved = false;

	constructor(app: App, private currentFolder: string, private onResolve: (folder: string | null) => void) {
		super(app);
	}

	onOpen(): void {
		this.renderChoice();
	}

	private renderChoice(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle("Create sheet");
		contentEl.createEl("p", { text: "Where do you want to create this sheet?" });

		const currentLabel = this.currentFolder ? this.currentFolder : "vault root";
		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText(`Dossier actuel (${currentLabel})`)
				.setCta()
				.onClick(() => this.finish(this.currentFolder))
		);

		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText("Choose another folder…").onClick(() => this.renderPicker()))
			.addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.finish(null)));
	}

	/** Remplace le contenu par un champ de recherche et la liste filtrée des dossiers du coffre — retour possible vers renderChoice() sans fermer la modale. */
	private renderPicker(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle("Choose a folder");

		const searchEl = contentEl.createEl("input", {
			cls: "quillstone-folder-search",
			type: "text",
			placeholder: "Search for a folder…",
		});
		const listEl = contentEl.createDiv({ cls: "quillstone-folder-list" });

		const folders = collectFolders(this.app.vault.getRoot()).sort((a, b) =>
			folderLabel(a).localeCompare(folderLabel(b))
		);

		const renderList = (filter: string): void => {
			listEl.empty();
			const query = filter.trim().toLowerCase();
			const matches = query ? folders.filter((f) => folderLabel(f).toLowerCase().includes(query)) : folders;

			if (matches.length === 0) {
				listEl.createDiv({ cls: "quillstone-folder-empty", text: "No folder found." });
				return;
			}
			for (const folder of matches) {
				const item = listEl.createDiv({ cls: "quillstone-folder-item", text: folderLabel(folder) });
				item.addEventListener("click", () => this.finish(folder.path));
			}
		};

		searchEl.addEventListener("input", () => renderList(searchEl.value));
		renderList("");

		// Différé d'un tick : le focus arrive avant que la modale n'ait fini de
		// se redessiner sinon, sans effet (même précaution que MovePageModal).
		window.setTimeout(() => searchEl.focus());

		new Setting(contentEl).addButton((btn) => btn.setButtonText("Back").onClick(() => this.renderChoice()));
	}

	private finish(folder: string | null): void {
		this.resolved = true;
		this.close();
		this.onResolve(folder);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) this.onResolve(null);
	}
}

function folderLabel(folder: TFolder): string {
	return folder.path === "" ? "/ (vault root)" : folder.path;
}

/** Le dossier lui-même, plus tous ses descendants, récursivement. Pas vault.getAllFolders() (Obsidian 1.6.6+ seulement) : ce plugin déclare minAppVersion 1.4.0 (manifest.json). */
function collectFolders(folder: TFolder): TFolder[] {
	const result: TFolder[] = [folder];
	for (const child of folder.children) {
		if (child instanceof TFolder) result.push(...collectFolders(child));
	}
	return result;
}
