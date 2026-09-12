import { App, Modal, Notice, Setting } from "obsidian";

/**
 * Demande la position de destination pour déplacer une page (voir
 * view.ts:promptMovePage) via une modale Obsidian plutôt que
 * `window.prompt()` : Electron n'implémente pas ce dernier (il ne montre
 * aucune boîte de dialogue et l'appel se comporte comme une annulation
 * immédiate), ce qui rendait le bouton « Déplacer » silencieusement inopérant.
 */
export class MovePageModal extends Modal {
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
		this.setTitle("Move this page");
		contentEl.createEl("p", {
			text: `This page is currently page ${this.currentPage} of ${this.totalPages}. Which position should it move to?`,
		});

		new Setting(contentEl).setName("New position").addText((text) => {
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
			// Sans le différer d'un tick, le focus arrive avant que la modale
			// n'ait fini de s'attacher au DOM et n'a aucun effet.
			window.setTimeout(() => {
				text.inputEl.focus();
				text.inputEl.select();
			});
		});

		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText("Move").setCta().onClick(() => this.submit()))
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
