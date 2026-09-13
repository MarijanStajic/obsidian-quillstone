import {
	Editor,
	MarkdownFileInfo,
	MarkdownPostProcessorContext,
	MarkdownView,
	Menu,
	Notice,
	PaneType,
	Platform,
	Plugin,
	TFile,
	TFolder,
	normalizePath,
} from "obsidian";
import { DrawView, VIEW_TYPE_DRAW } from "./view";
import { Drawing, DrawingPage, createEmptyDrawing, newPdfSourceId, newStrokeId, serialize } from "./model";
import { DEFAULT_SETTINGS, QuillStoneSettingTab, QuillStoneSettings, mergeSettings } from "./settings";
import { DrawPreviewManager, parseEmbedWidth } from "./preview";
import { DrawEmbedLifecycle } from "./previewLifecycle";
import { configurePdfWorker, getPdfPageSize, loadPdfDocument } from "./pdf";
import { pickFile } from "./filePicker";
import { chooseDrawingFolder } from "./folderChoiceModal";
import { promptDrawingName } from "./nameDrawingModal";

/**
 * Marque un élément d'intégration déjà rempli par fillDrawEmbed(), pour ne
 * pas le retraiter. Sans ce garde-fou, remplir l'élément (empty() + insertion
 * du canvas) déclenche le MutationObserver ci-dessous, qui le retraiterait,
 * qui le déclencherait à nouveau, indéfiniment.
 */
const DRAW_EMBED_PROCESSED_ATTR = "data-quillstone-processed";

export default class QuillStonePlugin extends Plugin {
	settings: QuillStoneSettings = DEFAULT_SETTINGS;
	/** Rendu et cache des miniatures ![[feuille.draw]] intégrées dans les notes. */
	preview!: DrawPreviewManager;
	private embedObserver: MutationObserver | null = null;

	async onload(): Promise<void> {
		this.settings = mergeSettings(await this.loadData());
		this.preview = new DrawPreviewManager(this);

		// Affiché une seule fois, jamais réaffiché ensuite (voir
		// QuillStoneSettings.hasShownScribbleNotice) : iPadOS peut, via sa
		// fonction Scribble, avaler silencieusement des événements du stylet
		// juste après qu'il a touché l'écran (bug WebKit documenté) — QuillStone
		// s'en protège déjà côté code, mais désactiver Scribble reste la
		// garantie la plus fiable pour qui dessine beaucoup. Seulement sur
		// l'app iOS : ce réglage n'existe pas ailleurs.
		if (Platform.isIosApp && !this.settings.hasShownScribbleNotice) {
			this.settings.hasShownScribbleNotice = true;
			void this.saveSettings();
			new Notice(
				"QuillStone tip: on iPad, if the pen ever seems briefly unresponsive right after lifting it, go to Settings → Apple Pencil → Scribble and turn it off. iPadOS's Scribble feature can interfere with drawing input in web-based apps like this one.",
				15000
			);
		}

		// 1. La vue qui affichera les feuilles.
		this.registerView(VIEW_TYPE_DRAW, (leaf) => new DrawView(leaf, this));

		// 2. On dit à Obsidian que les fichiers .draw s'ouvrent avec cette vue.
		//    Sans cela, un clic sur le fichier afficherait « format non pris en charge ».
		this.registerExtensions(["draw"], VIEW_TYPE_DRAW);

		this.addSettingTab(new QuillStoneSettingTab(this.app, this));

		// 2bis. Bouton dans le ruban (colonne d'icônes à gauche) : accessible
		// sans avoir de note ouverte, contrairement à la commande d'insertion
		// (editorCallback) ou au clic droit dans une note. Propose les deux
		// façons de créer une feuille, chacune demandant ensuite le dossier de
		// destination via resolveTargetFolder (voir ces méthodes plus bas).
		this.addRibbonIcon("pencil", "New drawing sheet", (evt: MouseEvent) => {
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle("Blank sheet")
					.setIcon("file-plus")
					.onClick(() => void this.createStandaloneDrawing())
			);
			menu.addItem((item) =>
				item
					.setTitle("Import a PDF")
					.setIcon("file-input")
					.onClick(() => void this.importPdfAsDrawing(this.app.workspace.getActiveFile()))
			);
			menu.showAtMouseEvent(evt);
		});

		// 3. Commande, accessible depuis la palette et assignable à un raccourci
		//    clavier dans Paramètres > Raccourcis clavier.
		this.addCommand({
			id: "insert-drawing",
			name: "Insert a drawing sheet",
			// Sans icône, Obsidian retombe sur un point d'interrogation générique
			// dès qu'on ajoute cette commande aux actions rapides (barre d'outils
			// mobile) — voir le bug signalé.
			icon: "file-plus",
			editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
				void this.insertDrawing(editor, ctx.file ?? null);
			},
		});

		// 4. Même action au clic droit dans une note.
		this.registerEvent(
			this.app.workspace.on(
				"editor-menu",
				(menu: Menu, editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
					menu.addItem((item) =>
						item
							.setTitle("Insert a drawing sheet")
							.setIcon("pencil")
							.onClick(() => void this.insertDrawing(editor, ctx.file ?? null))
					);
					menu.addItem((item) =>
						item
							.setTitle("Import a PDF as a drawing sheet")
							.setIcon("file-input")
							.onClick(() => void this.insertPdfDrawing(editor, ctx.file ?? null))
					);
				}
			)
		);

		// 3bis. Import PDF, sans passer par une note (palette de commandes
		// seule) : chaque page du PDF devient une page de la feuille créée,
		// avec la page rasterisée en fond verrouillé (voir importPdfAsDrawing)
		// — l'utilisateur dessine par-dessus avec les outils habituels.
		this.addCommand({
			id: "import-pdf-drawing",
			name: "Import a PDF as a drawing sheet",
			// Même raison que pour "insert-drawing" ci-dessus : sans icône
			// explicite, une action rapide ajoutée pour cette commande affiche un
			// point d'interrogation générique.
			icon: "file-input",
			callback: () => void this.importPdfAsDrawing(null),
		});

		// 5. Aperçu intégré ![[feuille.draw]] : Obsidian crée un élément
		//    d'intégration pour cette syntaxe dans les deux modes (Lecture et
		//    Live Preview), avec l'icône de fichier générique et le nom du lien
		//    puisqu'il ne reconnaît pas l'extension. On vide cet élément et on y
		//    insère notre propre canvas — jamais en le remplaçant lui-même, ce
		//    qui a précédemment échoué en Live Preview (voir plus bas pourquoi).
		this.registerMarkdownPostProcessor((el, ctx) => {
			el.querySelectorAll<HTMLElement>(".internal-embed").forEach((embedEl) => {
				const src = embedEl.getAttribute("src");
				if (!src || !src.toLowerCase().endsWith(".draw")) return;
				this.fillDrawEmbed(embedEl, src, ctx.sourcePath, ctx);
			});
		});

		// 6. Le post-processeur ci-dessus ne suffit pas seul en Live Preview :
		//    Obsidian peut peupler l'élément d'intégration (icône + nom)
		//    APRÈS le passage du post-processeur, écrasant ce qu'on vient d'y
		//    mettre. On observe donc aussi le conteneur de l'espace de travail
		//    pour repérer une intégration .draw qui apparaît (ou se remplit)
		//    plus tard, et lui appliquer le même remplissage.
		this.setupEmbedObserver();

		// 7. Une feuille modifiée dans un onglet doit rafraîchir sa miniature
		//    dans les notes qui l'intègrent, affichées dans d'autres onglets.
		//    invalidate() retouche directement tous les conteneurs suivis,
		//    qu'ils viennent du mode Lecture ou de l'édition en direct : les
		//    deux passent par le même remplissage, donc le même suivi.
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && file.extension === "draw") {
					void this.preview.invalidate(file);
				}
			})
		);
	}

	onunload(): void {
		this.embedObserver?.disconnect();
		this.embedObserver = null;
		this.preview?.clear();
	}

	/**
	 * Observe tout le conteneur de l'espace de travail (tous les panneaux,
	 * onglets, scissions confondus) plutôt qu'un éditeur en particulier : plus
	 * simple à faire vivre qu'un observateur par vue, un seul à connecter et
	 * à déconnecter. On filtre ensuite sur les éléments .internal-embed
	 * ciblant un .draw, donc le coût des mutations non pertinentes reste
	 * négligeable (un hasAttribute + un test d'extension).
	 */
	private setupEmbedObserver(): void {
		this.embedObserver = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				this.scanForDrawEmbeds(mutation.target);
				mutation.addedNodes.forEach((node) => this.scanForDrawEmbeds(node));
			}
		});
		this.embedObserver.observe(this.app.workspace.containerEl, {
			childList: true,
			subtree: true,
		});
	}

	private scanForDrawEmbeds(node: Node): void {
		if (!node.instanceOf(HTMLElement)) return;

		const descendants = Array.from(node.querySelectorAll<HTMLElement>(".internal-embed"));
		const candidates = node.matches(".internal-embed") ? [node, ...descendants] : descendants;

		for (const embedEl of candidates) {
			if (embedEl.hasAttribute(DRAW_EMBED_PROCESSED_ATTR)) continue;
			const src = embedEl.getAttribute("src");
			if (!src || !src.toLowerCase().endsWith(".draw")) continue;

			const sourcePath = this.findSourcePathFor(embedEl);
			if (sourcePath === null) continue; // pas dans une note ouverte connue : impossible de résoudre le lien relatif correctement

			this.fillDrawEmbed(embedEl, src, sourcePath);
		}
	}

	/** Remonte jusqu'à la vue Markdown qui contient cet élément, pour en tirer le chemin de la note source (nécessaire à getFirstLinkpathDest pour les liens relatifs). */
	private findSourcePathFor(el: HTMLElement): string | null {
		let sourcePath: string | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (sourcePath !== null) return;
			if (!(leaf.view instanceof MarkdownView)) return;
			if (leaf.view.containerEl.contains(el)) {
				sourcePath = leaf.view.file?.path ?? null;
			}
		});
		return sourcePath;
	}

	/**
	 * Fonction de remplissage unique, appelée aussi bien par le
	 * post-processeur que par l'observateur de mutations ci-dessus : les deux
	 * chemins doivent produire un aperçu identique. Résout le lien (chemins
	 * relatifs compris, via getFirstLinkpathDest), puis délègue le rendu à
	 * DrawPreviewManager. Se marque elle-même comme traitée avant tout le
	 * reste : voir DRAW_EMBED_PROCESSED_ATTR, la protection contre les
	 * boucles.
	 */
	private fillDrawEmbed(
		embedEl: HTMLElement,
		src: string,
		sourcePath: string,
		ctx?: MarkdownPostProcessorContext
	): void {
		if (embedEl.hasAttribute(DRAW_EMBED_PROCESSED_ATTR)) return;
		embedEl.setAttribute(DRAW_EMBED_PROCESSED_ATTR, "true");

		const file = this.app.metadataCache.getFirstLinkpathDest(src, sourcePath);

		const width = parseEmbedWidth(embedEl);

		// ctx.addChild n'est disponible que depuis le post-processeur ; pour un
		// élément trouvé par l'observateur, DrawPreviewManager.invalidate()
		// nettoie de toute façon les conteneurs détachés (voir preview.ts).
		if (ctx && file) ctx.addChild(new DrawEmbedLifecycle(embedEl, this.preview, file.path));
		void this.preview.mount(embedEl, file, src, width);
	}

	/**
	 * Demande où créer une nouvelle feuille : dossier de la note passée (ou
	 * de la note active si aucune n'est fournie, cas des entrées sans
	 * éditeur comme le ruban), ou un autre dossier au choix — voir
	 * chooseDrawingFolder. `null` signifie que l'utilisateur a annulé.
	 */
	private async resolveTargetFolder(note: TFile | null): Promise<string | null> {
		const active = note ?? this.app.workspace.getActiveFile();
		const currentFolder = active?.parent instanceof TFolder ? active.parent.path : "";
		return chooseDrawingFolder(this.app, currentFolder);
	}

	/** Nom par défaut proposé (horodatage) dans la modale de nom d'une feuille blanche — voir promptDrawingName. */
	private defaultDrawingName(): string {
		return `Sheet ${window.moment().format("YYYY-MM-DD HHmmss")}`;
	}

	/**
	 * Crée un fichier .draw à côté de la note courante, insère le lien d'intégration
	 * à la position du curseur, puis ouvre la feuille dans un nouvel onglet.
	 */
	private async insertDrawing(editor: Editor, note: TFile | null): Promise<void> {
		const folder = await this.resolveTargetFolder(note);
		if (folder === null) return; // annulé par l'utilisateur

		const name = await promptDrawingName(this.app, this.defaultDrawingName());
		if (name === null) return; // annulé par l'utilisateur

		try {
			const file = await this.createDrawingFile(folder, name);
			editor.replaceSelection(`![[${file.path}]]\n`);
			await this.openDrawing(file);
		} catch (error) {
			console.error(error);
			new Notice("Could not create the sheet.");
		}
	}

	/** Même création que insertDrawing(), pour le bouton du ruban : pas d'éditeur à disposition, donc pas de lien à insérer, juste l'ouverture de la feuille créée. */
	private async createStandaloneDrawing(): Promise<void> {
		const folder = await this.resolveTargetFolder(null);
		if (folder === null) return;

		const name = await promptDrawingName(this.app, this.defaultDrawingName());
		if (name === null) return;

		try {
			const file = await this.createDrawingFile(folder, name);
			await this.openDrawing(file);
		} catch (error) {
			console.error(error);
			new Notice("Could not create the sheet.");
		}
	}

	private async createDrawingFile(folder: string, name: string): Promise<TFile> {
		const path = this.uniqueVaultPath(folder, name, "draw");

		return this.app.vault.create(
			path,
			serialize(createEmptyDrawing(this.settings.defaultBackground, this.settings.defaultDensity))
		);
	}

	/** Chemin de fichier disponible dans `folder` pour `base.extension`, dédoublonné par un compteur — partagé par createDrawingFile, importPdfAsDrawing, et view.ts:exportToPdf. */
	uniqueVaultPath(folder: string, base: string, extension: string): string {
		let path = normalizePath(folder ? `${folder}/${base}.${extension}` : `${base}.${extension}`);
		let counter = 1;
		while (this.app.vault.getAbstractFileByPath(path)) {
			path = normalizePath(
				folder ? `${folder}/${base} ${counter}.${extension}` : `${base} ${counter}.${extension}`
			);
			counter++;
		}
		return path;
	}

	/**
	 * Pointe pdf.js vers son Worker (embarqué dans main.js, voir
	 * pdf.ts:configurePdfWorker) — une seule fois, idempotent. Partagé par
	 * l'import PDF en nouvelle feuille (ci-dessous) ET par le bouton d'import
	 * de la barre d'outils d'une feuille déjà ouverte (voir
	 * view.ts:importPdfIntoDocument).
	 */
	ensurePdfWorkerConfigured(): void {
		configurePdfWorker();
	}

	/**
	 * Écrit `data` comme fichier PRIVÉ du plugin (voir buildPdfPages, seul
	 * appelant), dans un sous-dossier de `manifest.dir` — jamais dans
	 * l'espace de notes de l'utilisateur, donc jamais visible dans
	 * l'explorateur de fichiers ni comme pièce jointe à côté de la feuille
	 * importée (un essai précédent de cette fonctionnalité écrivait un vrai
	 * fichier .pdf à côté du .draw : gênant, en plus d'être inutile — voir
	 * la doc de buildPdfPages pour pourquoi un fichier séparé reste
	 * nécessaire). `this.app.vault.adapter` (pas `this.app.vault`) : ce
	 * dossier n'est pas indexé comme fichier de coffre, `vault.createBinary`
	 * échouerait dessus. Renvoie le chemin, relatif au coffre, du fichier
	 * écrit.
	 */
	private async storePdfPrivately(data: ArrayBuffer): Promise<string> {
		if (!this.manifest.dir) throw new Error("Plugin folder not found.");
		const dir = normalizePath(`${this.manifest.dir}/imported-pdfs`);
		if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
		const path = normalizePath(`${dir}/${newPdfSourceId()}.pdf`);
		await this.app.vault.adapter.writeBinary(path, data);
		return path;
	}

	/**
	 * Construit les DrawingPage d'un PDF importé — une par page du PDF, dont
	 * l'image de fond référence, via ImageElement.pdfPage (model.ts), un
	 * fichier PDF écrit UNE SEULE FOIS dans le stockage privé du plugin (voir
	 * storePdfPrivately), jamais une fois par page qui le référence. Un PDF
	 * encodé en base64 DANS le .draw (l'approche initiale de cette
	 * fonctionnalité) grossit son fichier de ~33 % et, pour un PDF volumineux
	 * (scans haute résolution), peut dépasser la longueur de chaîne maximale
	 * du moteur JS dès la première page — `JSON.stringify` échoue alors avec
	 * `RangeError: Invalid string length`, quel que soit le nombre de copies
	 * (c'est ce qui faisait échouer l'import d'un PDF de 61 pages) : écrire
	 * un fichier binaire séparé supprime complètement cette limite. Chaque
	 * bitmap de page se rend à la demande (voir imageCache.ts, qui lit ce
	 * fichier), cette méthode ne fait que lire les dimensions de chaque page
	 * (bon marché, pas de rendu). Partagée par importPdfAsDrawing (nouvelle
	 * feuille, ci-dessous) et view.ts:importPdfIntoDocument (feuille déjà
	 * ouverte) — les deux points d'entrée de la fonctionnalité. `notice`, si
	 * fourni, reçoit la progression page par page.
	 */
	async buildPdfPages(pdfFile: File, notice?: Notice): Promise<DrawingPage[]> {
		this.ensurePdfWorkerConfigured();
		const arrayBuffer = await pdfFile.arrayBuffer();

		const pdfPath = await this.storePdfPrivately(arrayBuffer);

		const doc = await loadPdfDocument(arrayBuffer);
		try {
			if (doc.numPages === 0) throw new Error("PDF sans aucune page.");

			const pages: DrawingPage[] = [];
			for (let i = 1; i <= doc.numPages; i++) {
				notice?.setMessage(`Importing PDF… page ${i}/${doc.numPages}`);
				const { width, height } = await getPdfPageSize(doc, i);
				pages.push({
					width,
					height,
					background: "blank",
					orientation: width > height ? "landscape" : "portrait",
					density: this.settings.defaultDensity,
					elements: [
						{
							id: newStrokeId(),
							type: "image",
							path: pdfPath,
							pdfPage: i,
							x: 0,
							y: 0,
							width,
							height,
							rotation: 0,
							locked: true,
						},
					],
				});
			}
			return pages;
		} finally {
			void doc.destroy();
		}
	}

	/**
	 * Même geste que insertDrawing(), pour un PDF plutôt qu'une feuille vide :
	 * insère le lien d'intégration à la position du curseur, puis ouvre la
	 * feuille importée.
	 */
	private async insertPdfDrawing(editor: Editor, note: TFile | null): Promise<void> {
		const file = await this.importPdfAsDrawing(note);
		if (file) editor.replaceSelection(`![[${file.path}]]\n`);
	}

	/**
	 * Convertit un PDF choisi par l'utilisateur en feuille .draw : une page du
	 * document par page du PDF, chacune référençant sa page via ImageElement
	 * en fond verrouillé (voir ImageElement.pdfPage, model.ts) — sélectionnable
	 * et supprimable comme n'importe quel élément, mais jamais déplacée par
	 * inadvertance pendant qu'on dessine par-dessus au stylo. Le PDF lui-même
	 * est écrit UNE SEULE FOIS dans le stockage privé du plugin (voir
	 * buildPdfPages/storePdfPrivately, partagées avec
	 * view.ts:importPdfIntoDocument, et leur doc pour pourquoi — jamais
	 * encodé dans le .draw lui-même, jamais non plus une pièce jointe
	 * visible à côté). Renvoie `null` si l'utilisateur annule le sélecteur
	 * de fichier ou si l'import échoue.
	 */
	private async importPdfAsDrawing(note: TFile | null): Promise<TFile | null> {
		const pdfFile = await pickFile("application/pdf");
		if (!pdfFile) return null;

		const folder = await this.resolveTargetFolder(note);
		if (folder === null) return null; // annulé par l'utilisateur

		const defaultName = pdfFile.name.replace(/\.pdf$/i, "").trim() || "Imported PDF";
		const baseName = await promptDrawingName(this.app, defaultName);
		if (baseName === null) return null; // annulé par l'utilisateur

		const notice = new Notice("Importing PDF…", 0);
		try {
			const drawPath = this.uniqueVaultPath(folder, baseName, "draw");

			const pages = await this.buildPdfPages(pdfFile, notice);

			const drawing: Drawing = { version: 3, pages };
			const drawFile = await this.app.vault.create(drawPath, serialize(drawing));
			notice.hide();
			new Notice(`PDF imported: ${pages.length} page${pages.length > 1 ? "s" : ""}.`);
			await this.openDrawing(drawFile);
			return drawFile;
		} catch (error) {
			console.error("[quillstone] échec de l'import PDF :", error);
			notice.hide();
			new Notice("Could not import this PDF.");
			return null;
		}
	}

	/**
	 * Ouvre la feuille. `paneType` : "tab" (nouvel onglet, focus), "split"
	 * (à côté, focus — clic milieu/Ctrl-clic sur un aperçu intégré, voir
	 * preview.ts), ou `false` (réutilise l'onglet courant, navigable —
	 * simple clic sur un aperçu intégré : pas de second onglet, juste la
	 * même place qui bascule de la note vers la feuille). Garde-fou
	 * explicite : un TFile absent ou sans chemin ne doit jamais atteindre
	 * openFile, qui échouerait silencieusement (ou avec un message d'erreur
	 * qui ne dit pas d'où vient le problème).
	 */
	async openDrawing(file: TFile, paneType: PaneType | boolean = "tab"): Promise<void> {
		if (!file || !file.path) {
			console.error("[quillstone] openDrawing appelé avec un fichier invalide :", file);
			new Notice("Could not open the sheet: invalid file.");
			return;
		}
		const leaf = this.app.workspace.getLeaf(paneType);
		await leaf.openFile(file, { active: true });
	}

	/**
	 * Révèle le fichier dans le panneau Explorateur de fichiers, pour le menu
	 * contextuel d'un aperçu intégré. Il n'existe pas d'API publique pour
	 * ça : on passe par la vue interne "file-explorer", protégé par des
	 * vérifications défensives puisque cette méthode n'est pas documentée et
	 * pourrait changer d'une version d'Obsidian à l'autre.
	 */
	revealInFileExplorer(file: TFile): void {
		const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
		const view = leaf?.view as { revealInFolder?: (file: TFile) => void } | undefined;
		if (!leaf || typeof view?.revealInFolder !== "function") {
			new Notice("Could not reveal the file in the file explorer.");
			return;
		}
		view.revealInFolder(file);
		void this.app.workspace.revealLeaf(leaf);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * Les vues déjà ouvertes ne relisent pas les réglages seules : on les
	 * pousse à se redessiner après un changement dans l'onglet de réglages.
	 * refreshToolbar() reconstruit en plus la barre d'outils (palettes de
	 * couleurs comprises) : sans ça, remplacer une teinte dans les réglages
	 * n'apparaîtrait dans une vue déjà ouverte qu'au prochain changement
	 * d'outil.
	 */
	refreshOpenDrawViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_DRAW)) {
			if (leaf.view instanceof DrawView) {
				leaf.view.refreshToolbar();
				leaf.view.render();
			}
		}
	}
}
