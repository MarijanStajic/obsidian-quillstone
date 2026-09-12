/**
 * Sélecteur de fichier natif générique, partagé par tout ce qui doit
 * demander un fichier à l'utilisateur (import PDF depuis main.ts ET depuis
 * la barre d'outils d'une feuille ouverte, voir view.ts) : Obsidian n'expose
 * pas de dialogue de fichier propre au plugin, on passe donc par un
 * `<input type="file">` HTML standard, détaché du DOM (jamais affiché),
 * comme le font la plupart des plugins communautaires pour ce besoin.
 */
export function pickFile(accept: string): Promise<File | null> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = accept;
		input.setCssStyles({ display: "none" });
		const cleanup = (file: File | null) => {
			input.remove();
			resolve(file);
		};
		// "cancel" : émis par Chromium quand l'utilisateur ferme le sélecteur
		// sans choisir de fichier — sans ce cas, la promesse ne se résoudrait
		// jamais et l'input resterait indéfiniment détaché dans le DOM.
		input.addEventListener("change", () => cleanup(input.files?.[0] ?? null), { once: true });
		input.addEventListener("cancel", () => cleanup(null), { once: true });
		document.body.appendChild(input);
		input.click();
	});
}
