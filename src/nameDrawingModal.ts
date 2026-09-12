import { App, Modal, Notice, Setting } from "obsidian";

/**
 * Demande le nom de la nouvelle feuille avant de la créer — feuille blanche
 * (horodatage proposé par défaut) ou import PDF (nom du PDF proposé par
 * défaut), voir main.ts. Pré-rempli et modifiable, jamais vide (voir
 * submit()). Renvoie `null` si l'utilisateur annule.
 */
export function promptDrawingName(app: App, defaultName: string): Promise<string | null> {
	return new Promise((resolve) => {
		new NameDrawingModal(app, defaultName, resolve).open();
	});
}

/** Caractères interdits dans un nom de fichier (Windows, le plus restrictif des systèmes visés) : remplacés plutôt que de laisser vault.create() échouer avec une erreur peu claire. */
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|]/g;

class NameDrawingModal extends Modal {
	private inputEl!: HTMLInputElement;
	private resolved = false;

	constructor(app: App, private defaultName: string, private onResolve: (name: string | null) => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle("Sheet name");

		new Setting(contentEl).setName("File name").addText((text) => {
			this.inputEl = text.inputEl;
			text.setValue(this.defaultName);
			text.inputEl.addEventListener("keydown", (evt) => {
				if (evt.key !== "Enter") return;
				evt.preventDefault();
				this.submit();
			});
			// Différé d'un tick : le focus arrive avant que la modale n'ait fini
			// de s'attacher au DOM sinon, sans effet.
			window.setTimeout(() => {
				text.inputEl.focus();
				text.inputEl.select();
			});
		});

		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText("Create").setCta().onClick(() => this.submit()))
			.addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.finish(null)));
	}

	private submit(): void {
		const name = this.inputEl.value.trim().replace(INVALID_FILENAME_CHARS, "-");
		if (!name) {
			new Notice("Enter a name for the sheet.");
			return;
		}
		this.finish(name);
	}

	private finish(name: string | null): void {
		this.resolved = true;
		this.close();
		this.onResolve(name);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) this.onResolve(null);
	}
}
