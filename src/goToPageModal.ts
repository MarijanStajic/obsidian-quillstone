import { App, Modal, Notice, Setting } from "obsidian";

/**
 * Demande un numéro de page à atteindre (voir view.ts:promptGoToPage, ouvert
 * depuis l'indicateur « Page X / N » de la barre d'outils) via une modale
 * Obsidian plutôt que `window.prompt()`, qu'Electron n'implémente pas (même
 * précaution que MovePageModal).
 */
export class GoToPageModal extends Modal {
	private inputEl!: HTMLInputElement;

	constructor(
		app: App,
		private currentPage: number,
		private totalPages: number,
		private onSubmit: (targetPage: number) => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle("Go to page");

		new Setting(contentEl).setName(`Page number (1 to ${this.totalPages})`).addText((text) => {
			this.inputEl = text.inputEl;
			text.inputEl.type = "number";
			text.inputEl.min = "1";
			text.inputEl.max = String(this.totalPages);
			text.setValue(String(this.currentPage));
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
			.addButton((btn) => btn.setButtonText("Go").setCta().onClick(() => this.submit()))
			.addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()));
	}

	private submit(): void {
		const target = Number.parseInt(this.inputEl.value.trim(), 10);
		if (!Number.isInteger(target) || target < 1 || target > this.totalPages) {
			new Notice(`Invalid page number: enter a whole number between 1 and ${this.totalPages}.`);
			return;
		}
		this.close();
		this.onSubmit(target);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
