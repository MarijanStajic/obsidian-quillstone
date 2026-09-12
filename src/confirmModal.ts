import { App, Modal, Setting } from "obsidian";

/**
 * Confirmation via une modale Obsidian plutôt que `window.confirm()` — même
 * précaution que GoToPageModal/MovePageModal pour `window.prompt()` :
 * bloquant, absent sur mobile, et incohérent avec le reste de l'interface.
 */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private message: string,
		private confirmLabel: string,
		private onConfirm: () => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle(this.title);
		contentEl.createEl("p", { text: this.message });

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText(this.confirmLabel)
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			)
			.addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
