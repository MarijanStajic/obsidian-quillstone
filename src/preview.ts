import { Menu, TFile, setIcon, setTooltip } from "obsidian";
import type QuillStonePlugin from "./main";
import { Drawing, ImageElement, parse } from "./model";
import { renderScene } from "./render";
import { resolveColors } from "./colors";
import { ImageElementCache } from "./imageCache";

/** Résolution de rendu d'une miniature intégrée, en pixels logiques : c'est un aperçu, pas la page (voir mount()). La largeur d'affichage CSS est fluide (100 % du corps de la note, comme du texte) — cette constante ne fixe que la résolution du canvas sous-jacent. */
export const THUMBNAIL_WIDTH = 600;

/**
 * Hauteur affichée par défaut (repliée), en pixels CSS, quelle que soit la
 * largeur de la note — voir la fonctionnalité "aperçu déroulable" :
 * contrainte par la hauteur plutôt que par la largeur, une miniature de page
 * A4 (portrait) reste petite même dans une note très large.
 */
const COLLAPSED_HEIGHT_PX = 200;

/**
 * Palier de hauteur au dépliage, basculé par le même bouton à chaque clic :
 * replié (COLLAPSED_HEIGHT_PX) <-> pleine hauteur, directement — jamais de
 * palier intermédiaire à mi-hauteur (un ancien comportement à trois paliers,
 * qui demandait deux clics pour tout déplier ; un utilisateur qui clique sur
 * « voir plus » veut la feuille entière tout de suite, pas la moitié).
 */
type ExpandStep = 0 | 1;
const STEP_COUNT = 2;

interface CacheEntry {
	canvas: HTMLCanvasElement;
	mtime: number;
}

/**
 * Rend et met en cache les miniatures des feuilles .draw intégrées dans les
 * notes (![[feuille.draw]]). Un seul gestionnaire : le post-processeur ET
 * l'observateur de mutations (main.ts) l'utilisent tous deux pour construire
 * l'aperçu — mode Lecture et édition en direct passent par le même point
 * d'entrée (main.ts:fillDrawEmbed), donc par le même rendu.
 *
 * Le cache est indexé par (chemin, largeur de rendu) et invalidé par mtime :
 * si le fichier n'a pas changé depuis le dernier rendu, on réutilise le
 * canvas existant plutôt que de relire et retracer tous les traits — sans
 * ça, une note contenant plusieurs feuilles relirait et rejouerait tout à
 * chaque ouverture. `vault.on("modify")` (voir main.ts) appelle invalidate()
 * pour vider l'entrée et rafraîchir immédiatement tous les aperçus
 * actuellement affichés de ce fichier, dans les deux modes. Le dépliage ne
 * change jamais cette résolution — seule la hauteur visible (un simple
 * découpage CSS, voir buildEmbedDom) varie — donc pas de second rendu à
 * indexer pour ça.
 */
export class DrawPreviewManager {
	private cache = new Map<string, CacheEntry>();
	/** Conteneurs actuellement affichés par chemin de fichier, avec la largeur demandée (null = largeur responsive). */
	private containers = new Map<string, Map<HTMLElement, number | null>>();
	/** Empêche un montage en retard (rendu async) d'écraser un montage plus récent du même conteneur. */
	private generations = new WeakMap<HTMLElement, number>();
	/**
	 * hostEl déjà câblés par wireInteractions (voir buildEmbedDom) — un même
	 * conteneur est remonté plusieurs fois au fil de sa vie (invalidate() à
	 * chaque modification du fichier, changement de page via buildPager…),
	 * mais hostEl.empty() ne vide que ses ENFANTS : les écouteurs posés
	 * directement sur hostEl lui-même (clic pour ouvrir la feuille) survivent
	 * d'un montage à l'autre. Sans ce garde-fou, chaque remontage empilerait
	 * un nouvel écouteur "ouvrir" par-dessus les précédents, jamais retiré —
	 * un simple clic finissait par ouvrir la feuille en autant d'onglets que
	 * de remontages passés.
	 */
	private wiredHosts = new WeakSet<HTMLElement>();
	/**
	 * Palier de dépliage par intégration (0 = replié, voir ExpandStep),
	 * modifié par le clic sur le bouton (buildEmbedDom). Indexé par élément
	 * hôte, pas par chemin : une même feuille intégrée deux fois dans la note
	 * garde deux états indépendants. Une WeakMap suffit — la fonctionnalité ne
	 * demande pas de survivre à la fermeture de la note, seulement à un
	 * remontage du même conteneur (invalidate() réutilise le même hostEl,
	 * voir plus bas).
	 */
	private expandStep = new WeakMap<HTMLElement, ExpandStep>();
	/**
	 * Page actuellement affichée par intégration (0 = la première), modifiée
	 * par les boutons de pagination (voir buildEmbedDom) — indexée par
	 * élément hôte comme expandStep, pour la même raison : ça doit survivre
	 * à un remontage du même conteneur (invalidate(), ou changer de page
	 * elle-même, qui rappelle mount()), sans quoi feuilleter jusqu'à la page
	 * 3 puis modifier le fichier ailleurs ramènerait silencieusement
	 * l'aperçu à la page 1.
	 */
	private currentPage = new WeakMap<HTMLElement, number>();
	/**
	 * Même mécanisme que la vue principale (voir imageCache.ts), mais une
	 * seule instance partagée par toutes les miniatures plutôt qu'une par
	 * feuille ouverte : une image collée dans plusieurs feuilles n'est chargée
	 * qu'une fois. `onLoaded` ignoré ici — renderCached() attend explicitement
	 * (waitFor) que chaque image de la feuille soit prête avant de composer le
	 * canvas, il n'y a jamais de second rendu réactif à déclencher. Assignée
	 * dans le constructeur (pas en initialiseur de champ) : elle a besoin de
	 * `this.plugin`, affecté par TypeScript après les initialiseurs de champ.
	 */
	private imageCache: ImageElementCache;

	constructor(private plugin: QuillStonePlugin) {
		this.imageCache = new ImageElementCache(this.plugin.app, () => {});
		// Une miniature peut être la toute première chose à afficher une page de
		// PDF importée (voir ImageElement.pdfPage) — sans qu'aucune DrawView de
		// ce coffre n'ait encore été ouverte pour le faire elle-même.
		this.plugin.ensurePdfWorkerConfigured();
	}

	/**
	 * Construit (ou reconstruit) la miniature dans hostEl pour `file` — ou un
	 * message d'erreur clair si `file` est `null` (lien non résolu). hostEl
	 * doit être retiré du suivi via untrack() quand il n'est plus affiché,
	 * sans quoi il continuerait à être rafraîchi indéfiniment.
	 */
	async mount(
		hostEl: HTMLElement,
		file: TFile | null,
		linktext: string,
		requestedWidth: number | null
	): Promise<void> {
		const generation = (this.generations.get(hostEl) ?? 0) + 1;
		this.generations.set(hostEl, generation);

		hostEl.empty();
		hostEl.addClass("quillstone-embed");
		hostEl.removeClass("quillstone-embed-missing");
		hostEl.removeClass("quillstone-embed-error");

		if (!file || !file.path) {
			// TEMP : diagnostic — confirme que le rendu s'arrête bien ici plutôt
			// que de laisser passer un TFile ou un chemin vide plus loin.
			console.warn(`[quillstone] Aperçu introuvable pour le lien "${linktext}" (file =`, file, ").");
			hostEl.addClass("quillstone-embed-missing");
			hostEl.setText(
				`Sheet not found: "${linktext}". Check the link's path, or whether the file has been moved or renamed.`
			);
			return;
		}

		this.track(file.path, hostEl, requestedWidth);
		const renderWidth = requestedWidth ?? THUMBNAIL_WIDTH;
		const step = this.expandStep.get(hostEl) ?? 0;

		try {
			const drawing = await this.loadDrawing(file);
			if (this.generations.get(hostEl) !== generation) return;

			// Ramenée dans les limites du document à chaque montage : si le
			// fichier a perdu des pages depuis le dernier passage ici (édité
			// ailleurs), une page mémorisée qui n'existe plus retomberait sur
			// la dernière restante plutôt que de planter.
			const totalPages = drawing.pages.length;
			const pageIndex = Math.min(this.currentPage.get(hostEl) ?? 0, totalPages - 1);
			this.currentPage.set(hostEl, pageIndex);

			const canvas = await this.renderCached(
				hostEl,
				file,
				drawing,
				renderWidth,
				pageIndex,
				`${file.path}::${renderWidth}::${pageIndex}`
			);
			if (this.generations.get(hostEl) !== generation) return; // un montage plus récent a déjà pris le dessus

			hostEl.empty();
			this.buildEmbedDom(hostEl, file, linktext, canvas, requestedWidth, step, pageIndex, totalPages);
		} catch (error) {
			if (this.generations.get(hostEl) !== generation) return;
			console.error("[quillstone] Échec du rendu de l'aperçu intégré :", error);
			hostEl.empty();
			hostEl.addClass("quillstone-embed-error");
			hostEl.setText(`Could not display "${file.basename}": unreadable or corrupted file.`);
		}
	}

	/** À appeler quand hostEl n'affiche plus ce fichier (élément retiré du DOM), pour arrêter de le rafraîchir. */
	untrack(path: string, hostEl: HTMLElement): void {
		const map = this.containers.get(path);
		if (!map) return;
		map.delete(hostEl);
		if (map.size === 0) this.containers.delete(path);
	}

	private track(path: string, hostEl: HTMLElement, requestedWidth: number | null): void {
		let map = this.containers.get(path);
		if (!map) {
			map = new Map();
			this.containers.set(path, map);
		}
		map.set(hostEl, requestedWidth);
	}

	private async loadDrawing(file: TFile): Promise<Drawing> {
		const raw = await this.plugin.app.vault.cachedRead(file);
		return parse(raw);
	}

	/**
	 * Rend la page `pageIndex` de `drawing` à `width` (pixels logiques) et
	 * met le résultat en cache sous `key` (qui inclut `pageIndex`, voir
	 * mount() — une même feuille a un canvas mis en cache par page réellement
	 * affichée), invalidé par mtime. La miniature n'affiche jamais qu'UNE
	 * page à la fois (voir la fonctionnalité « feuilleter l'aperçu ») ; le
	 * numéro de page et les boutons de navigation sont du DOM, pas peints
	 * dans le bitmap (voir buildEmbedDom) — un bouton ne peut pas être
	 * cliquable s'il est cuit dans un canvas.
	 */
	private async renderCached(
		refEl: HTMLElement,
		file: TFile,
		drawing: Drawing,
		width: number,
		pageIndex: number,
		key: string
	): Promise<HTMLCanvasElement> {
		const cached = this.cache.get(key);
		if (cached && cached.mtime === file.stat.mtime) return cached.canvas;

		const page = drawing.pages[pageIndex];

		// Sans ça, renderScene peint chaque image comme « en cours de
		// chargement » (voir RenderSceneOptions.resolveImage dans render.ts) :
		// la miniature n'a qu'une seule passe de rendu, contrairement à la vue
		// principale qui se redessine dès qu'une image termine de charger. On
		// attend donc ici que toutes les images de la page soient prêtes
		// (ou en erreur) avant de composer le canvas.
		const imageElements = page.elements.filter((el): el is ImageElement => el.type === "image");
		await Promise.all(imageElements.map((el) => this.imageCache.waitFor(el, drawing.pdfSources)));

		const colors = resolveColors(refEl, this.plugin.settings.paperAlwaysLight);

		const scale = width / page.width;
		const dpr = window.devicePixelRatio || 1;
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(width * dpr));
		canvas.height = Math.max(1, Math.round(page.height * scale * dpr));

		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Canvas 2D indisponible");
		ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
		renderScene(ctx, page, colors, { resolveImage: (el) => this.imageCache.get(el, drawing.pdfSources) });

		this.cache.set(key, { canvas, mtime: file.stat.mtime });
		return canvas;
	}

	/** Largeur d'affichage CSS du canvas : fluide (comme du texte) sauf largeur explicite ![[x|400]] — jamais affectée par le dépliage, qui ne joue que sur la hauteur visible (voir buildEmbedDom). */
	private applyCanvasWidth(canvas: HTMLCanvasElement, requestedWidth: number | null): void {
		canvas.style.width = requestedWidth ? `${requestedWidth}px` : "100%";
	}

	/**
	 * Hauteur naturelle (CSS, non rognée) du canvas à sa largeur d'affichage
	 * actuelle — dérivée du ratio intrinsèque du canvas (déjà rendu à
	 * `page.width`/`page.height` près) et de la largeur réellement
	 * obtenue une fois posé dans le document. Recalculée à chaque palier
	 * plutôt que mise en cache : reste juste si la note est redimensionnée
	 * entre deux clics.
	 */
	private naturalHeightPx(cropEl: HTMLElement, canvas: HTMLCanvasElement): number {
		const width = cropEl.getBoundingClientRect().width || canvas.width / (window.devicePixelRatio || 1);
		return width * (canvas.height / canvas.width);
	}

	/** Hauteur (CSS) du palier de dépliage donné — voir ExpandStep. */
	private stepHeightPx(step: ExpandStep, cropEl: HTMLElement, canvas: HTMLCanvasElement): number {
		return step === 0 ? COLLAPSED_HEIGHT_PX : this.naturalHeightPx(cropEl, canvas);
	}

	private syncToggleButton(btn: HTMLElement, step: ExpandStep): void {
		const atFull = step === STEP_COUNT - 1;
		// Chevron bas = "replié, cliquer déplie tout" ; chevron haut = "tout
		// est déplié, cliquer réduit" — jamais l'inverse d'une icône
		// maximiser/réduire générique, pour évoquer un "voir plus" qui invite
		// à continuer vers le bas (voir la fonctionnalité).
		setIcon(btn, atFull ? "chevron-up" : "chevron-down");
		const label = atFull ? "Collapse preview" : "View more";
		btn.setAttribute("aria-label", label);
		setTooltip(btn, label);
	}

	/**
	 * Construit le contenu de hostEl : un conteneur de rognage vertical
	 * (`.quillstone-embed-crop`, `overflow: hidden`) contenant le canvas
	 * fourni (déjà rendu à la bonne résolution par mount(), résolution jamais
	 * affectée par le dépliage — voir stepHeightPx), le bouton de dépliage
	 * en coin bas-droit, et — si le document a plus d'une page — les boutons
	 * de pagination en coin bas-gauche (voir buildPager). Le clic sur le
	 * bouton de dépliage ne relance jamais mount() ni aucun rendu : il fait
	 * uniquement basculer le palier de hauteur (0 <-> 1, voir ExpandStep) et
	 * ajuste `max-height` du conteneur de rognage en CSS pur (voir "Pas de
	 * re-rendu inutile" dans la fonctionnalité) — changer de page, en
	 * revanche, doit obligatoirement relancer un rendu (une autre page), donc
	 * un remontage complet via mount() (voir buildPager).
	 */
	private buildEmbedDom(
		hostEl: HTMLElement,
		file: TFile,
		linktext: string,
		canvas: HTMLCanvasElement,
		requestedWidth: number | null,
		initialStep: ExpandStep,
		pageIndex: number,
		totalPages: number
	): void {
		let step = initialStep;

		const cropEl = hostEl.createDiv({ cls: "quillstone-embed-crop" });
		canvas.addClass("quillstone-embed-canvas");
		this.applyCanvasWidth(canvas, requestedWidth);
		cropEl.appendChild(canvas);
		cropEl.style.maxHeight = `${this.stepHeightPx(step, cropEl, canvas)}px`;

		const toggleBtn = hostEl.createEl("button", { cls: "quillstone-embed-toggle", attr: { type: "button" } });
		this.syncToggleButton(toggleBtn, step);

		// Si la feuille entière tient déjà dans la hauteur repliée (page très
		// courte, ou large et peu haute malgré le format portrait attendu), il
		// n'y a rien à déplier : le bouton ne ferait rien de visible, autant le
		// masquer plutôt que d'inviter à un clic sans effet.
		if (this.naturalHeightPx(cropEl, canvas) <= COLLAPSED_HEIGHT_PX) {
			cropEl.style.maxHeight = "none";
			toggleBtn.hide();
		}

		toggleBtn.addEventListener("click", (evt) => {
			// Ne doit jamais ouvrir la feuille (voir wireInteractions, plus bas) :
			// seul un clic sur le corps de l'aperçu le fait.
			evt.preventDefault();
			evt.stopPropagation();

			step = step >= STEP_COUNT - 1 ? 0 : ((step + 1) as ExpandStep);
			this.expandStep.set(hostEl, step);
			cropEl.style.maxHeight = `${this.stepHeightPx(step, cropEl, canvas)}px`;
			this.syncToggleButton(toggleBtn, step);
		});

		if (totalPages > 1) this.buildPager(hostEl, file, linktext, requestedWidth, pageIndex, totalPages);

		// Une seule fois par hostEl (voir wiredHosts) : ce conteneur sera
		// remonté plusieurs fois au fil de sa vie (invalidate(), pagination),
		// mais ses écouteurs à lui — pas ceux de ses enfants, vidés à chaque
		// fois par hostEl.empty() — doivent rester uniques.
		if (!this.wiredHosts.has(hostEl)) {
			this.wiredHosts.add(hostEl);
			this.wireInteractions(hostEl, file);
		}
	}

	/**
	 * Boutons « page suivante » et « revenir à la page 1 », plus un repère
	 * « N/total » entre les deux — coin bas-gauche, symétrique du bouton de
	 * dépliage (bas-droit). Contrairement à ce dernier, un changement de
	 * page change RÉELLEMENT ce qui est rendu (une autre page du document) :
	 * chaque clic mémorise le nouvel index dans currentPage puis relance
	 * mount() en entier plutôt que de patcher le DOM à la main — un peu plus
	 * de travail que nécessaire pour un geste aussi rare (feuilleter un
	 * aperçu), mais qui garantit que le reste de l'intégration (bouton de
	 * dépliage, gestionnaires de clic) reste cohérent avec la page réellement
	 * affichée, reconstruit à l'identique par le même chemin que n'importe
	 * quel autre montage. La page mémorisée (voir currentPage) survit à ce
	 * remontage puisqu'elle est indexée par hostEl, jamais recréé ici — c'est
	 * ce qui la garde "fixe sur la page où on est" plutôt que de retomber sur
	 * la page 1 à chaque rafraîchissement.
	 */
	private buildPager(
		hostEl: HTMLElement,
		file: TFile,
		linktext: string,
		requestedWidth: number | null,
		pageIndex: number,
		totalPages: number
	): void {
		const pagerEl = hostEl.createDiv({ cls: "quillstone-embed-pager" });

		const firstBtn = pagerEl.createEl("button", { cls: "quillstone-embed-page-btn", attr: { type: "button" } });
		setIcon(firstBtn, "chevron-first");
		firstBtn.setAttribute("aria-label", "Back to first page");
		setTooltip(firstBtn, "Back to first page");

		const label = pagerEl.createDiv({ cls: "quillstone-embed-page-label" });
		label.setText(`${pageIndex + 1}/${totalPages}`);

		const nextBtn = pagerEl.createEl("button", { cls: "quillstone-embed-page-btn", attr: { type: "button" } });
		setIcon(nextBtn, "chevron-right");
		nextBtn.setAttribute("aria-label", "Next page");
		setTooltip(nextBtn, "Next page");

		// Rien à faire depuis la première page (revenir à elle-même), ni depuis
		// la dernière (pas de suivante) — vraiment désactivés (attribut natif,
		// pas seulement une classe visuelle) : ni clic ni activation clavier
		// n'y font quoi que ce soit. Grisés plutôt que masqués : la
		// disparition d'un bouton sous le curseur au fil des clics serait
		// déroutante, contrairement au bouton de dépliage (voir
		// buildEmbedDom), qui peut manquer complètement dès le départ.
		firstBtn.disabled = pageIndex === 0;
		nextBtn.disabled = pageIndex >= totalPages - 1;

		const goToPage = (evt: MouseEvent, target: number): void => {
			evt.preventDefault();
			evt.stopPropagation(); // jamais ouvrir la feuille (voir wireInteractions), comme le bouton de dépliage
			if (target === pageIndex) return;
			this.currentPage.set(hostEl, target);
			void this.mount(hostEl, file, linktext, requestedWidth);
		};
		firstBtn.addEventListener("click", (evt) => goToPage(evt, 0));
		nextBtn.addEventListener("click", (evt) => goToPage(evt, Math.min(pageIndex + 1, totalPages - 1)));
	}

	private wireInteractions(hostEl: HTMLElement, file: TFile): void {
		hostEl.addClass("quillstone-embed-clickable");
		hostEl.setAttribute("role", "button");
		hostEl.setAttribute("tabindex", "0");
		hostEl.setAttribute("aria-label", `Open ${file.basename}`);

		// Clic simple : reprend l'onglet courant (pas de second onglet — voir
		// openDrawing, main.ts) : la note laisse place à la feuille, au même
		// endroit. Ctrl/Cmd-clic ou clic milieu : à côté, dans un nouvel
		// onglet — comme les liens internes d'Obsidian.
		// stopPropagation() en plus de preventDefault() : sans ça, le clic
		// remonte jusqu'au gestionnaire natif d'Obsidian pour .internal-embed,
		// qui tente lui aussi d'ouvrir le lien et peut échouer sur une
		// extension qu'il ne reconnaît pas.
		const open = (evt: MouseEvent): void => {
			evt.preventDefault();
			evt.stopPropagation();
			// Garde-fou explicite : ne jamais tenter d'ouvrir un fichier absent
			// ou sans chemin, même si ce cas ne devrait normalement pas se
			// produire ici (wireInteractions n'est appelé qu'après un montage
			// réussi avec un TFile valide).
			if (!file || !file.path) {
				console.error("[quillstone] Clic ignoré : fichier invalide.", file);
				return;
			}
			const split = evt.button === 1 || evt.ctrlKey || evt.metaKey;
			void this.plugin.openDrawing(file, split ? "split" : false);
		};
		hostEl.addEventListener("click", open);
		hostEl.addEventListener("auxclick", (evt) => {
			if (evt.button === 1) open(evt);
		});
		hostEl.addEventListener("keydown", (evt) => {
			if (evt.key !== "Enter" && evt.key !== " ") return;
			evt.preventDefault();
			evt.stopPropagation();
			if (!file || !file.path) return;
			void this.plugin.openDrawing(file, "tab");
		});

		hostEl.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle("Open")
					.setIcon("pencil")
					.onClick(() => void this.plugin.openDrawing(file, "tab"))
			);
			menu.addItem((item) =>
				item
					.setTitle("Open to the side")
					.setIcon("separator-vertical")
					.onClick(() => void this.plugin.openDrawing(file, "split"))
			);
			menu.addItem((item) =>
				item
					.setTitle("Reveal in file explorer")
					.setIcon("folder-open")
					.onClick(() => this.plugin.revealInFileExplorer(file))
			);
			menu.showAtMouseEvent(evt);
		});
	}

	/**
	 * Un .draw modifié invalide sa miniature en cache et rafraîchit tous les
	 * aperçus actuellement affichés (voir main.ts, vault.on("modify")). Comme
	 * le mode Lecture et l'édition en direct passent tous deux par le même
	 * remplissage (main.ts:fillDrawEmbed), leurs conteneurs sont suivis et
	 * retouchés ici de façon identique.
	 */
	async invalidate(file: TFile): Promise<void> {
		for (const key of Array.from(this.cache.keys())) {
			if (key.startsWith(`${file.path}::`)) this.cache.delete(key);
		}

		const map = this.containers.get(file.path);
		if (!map) return;
		for (const [hostEl, requestedWidth] of Array.from(map)) {
			if (!hostEl.isConnected) {
				map.delete(hostEl);
				continue;
			}
			await this.mount(hostEl, file, file.path, requestedWidth);
		}
	}

	/** Vide le cache et le suivi des conteneurs affichés (voir main.ts, onunload). */
	clear(): void {
		this.cache.clear();
		this.containers.clear();
		this.imageCache.clear();
	}
}

/**
 * `![[feuille.draw|400]]` : Obsidian pose le texte suivant le `|` dans
 * l'attribut `alt` de l'élément d'intégration, y compris pour une extension
 * qu'il ne reconnaît pas — dans les deux modes. On lit aussi `width` par
 * prudence, au cas où une version future d'Obsidian le poserait directement.
 */
export function parseEmbedWidth(embedEl: HTMLElement): number | null {
	const raw = embedEl.getAttribute("width") ?? embedEl.getAttribute("alt");
	if (!raw) return null;
	const match = raw.match(/^(\d+)/);
	if (!match) return null;
	const width = Number(match[1]);
	return Number.isFinite(width) && width > 0 ? width : null;
}
