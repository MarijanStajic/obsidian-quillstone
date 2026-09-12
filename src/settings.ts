import { App, PluginSettingTab, Setting } from "obsidian";
import type QuillStonePlugin from "./main";
import { BackgroundKind, Density, Orientation, PaperFormat, ShapeKind } from "./model";
import { openColorPicker } from "./colorPicker";

/**
 * Outil actuellement sélectionné dans la barre d'outils. Les deux modes de
 * gomme sont distincts de ToolKind (model.ts) : une gomme ne produit jamais
 * de trait persisté, ce n'est donc pas une valeur possible de Stroke.tool.
 * "cursor" et "select" (le lasso) partagent toute la logique de sélection
 * (voir isSelectionTool, view.ts) ; seul le lasso peut entourer une zone vide.
 * Les quatre `ShapeKind` (model.ts) sont chacun leur propre outil, comme le
 * stylo ou le surligneur — tracés par glissement, avec la même couleur/
 * épaisseur active (voir DrawView.activeColorTool). "laser" ne produit
 * jamais d'élément persisté (voir DrawView.laserPoints) : c'est le seul
 * outil qui ne modifie jamais le document, purement une aide visuelle
 * pendant une présentation. "hand" non plus : clic-glisser (n'importe où,
 * y compris hors de toute page) panoramique la vue au lieu de dessiner ou
 * sélectionner (voir DrawView.isPanTrigger) — l'équivalent d'un clic
 * molette ou d'un espace maintenu, mais accessible sans clavier ni bouton
 * central, pour une souris simple sans pavé tactile. "capture" trace un
 * rectangle comme le curseur/lasso, mais n'entoure jamais des éléments
 * existants pour les sélectionner : il rasterise tout ce qu'il y a sous ce
 * rectangle (fond de page compris) en une nouvelle image, posée
 * immédiatement au même endroit — comme une capture d'écran collée sur la
 * feuille (voir DrawView.finishCapture).
 */
export type ActiveTool =
	| "pen"
	| "highlighter"
	| "eraser-zone"
	| "eraser-stroke"
	| "cursor"
	| "select"
	| "capture"
	| ShapeKind
	| "laser"
	| "hand";

/** Les trois outils qu'on choisirait raisonnablement comme point de départ à l'ouverture d'une feuille — pas les gommes, qui n'ont de sens qu'en cours de travail. Voir QuillStoneSettings.defaultTool. */
export type DefaultTool = "pen" | "cursor" | "select";
export const DEFAULT_TOOL_OPTIONS: DefaultTool[] = ["pen", "cursor", "select"];
export const DEFAULT_TOOL_LABELS: Record<DefaultTool, string> = {
	pen: "Pen",
	cursor: "Cursor",
	select: "Lasso",
};

/** Vocabulaire partagé entre le menu de fond de la barre d'outils (par document) et le sélecteur de fond par défaut (réglages du plugin). */
export const BACKGROUND_KINDS: BackgroundKind[] = [
	"blank",
	"grid",
	"lines",
	"dots",
	"seyes",
	"staff",
	"isometric",
];

export const BACKGROUND_LABELS: Record<BackgroundKind, string> = {
	blank: "Blank",
	grid: "Grid",
	lines: "Lines",
	dots: "Dots",
	seyes: "Seyès",
	staff: "Staff",
	isometric: "Isometric",
};

export const DENSITIES: Density[] = ["tight", "normal", "wide"];

export const DENSITY_LABELS: Record<Density, string> = {
	tight: "Tight",
	normal: "Normal",
	wide: "Wide",
};

/** Vocabulaire partagé entre le menu de format de la barre d'outils (par page) et un éventuel sélecteur de format par défaut, comme BACKGROUND_KINDS ci-dessus — du plus grand format au plus petit, puis les formats US. */
export const PAPER_FORMATS: PaperFormat[] = ["a3", "a4", "a5", "letter", "legal"];

export const PAPER_FORMAT_LABELS: Record<PaperFormat, string> = {
	a3: "A3",
	a4: "A4",
	a5: "A5",
	letter: "Letter",
	legal: "Legal",
};

/** Les deux seuls outils qui ont une couleur (contrairement à la gomme). */
export type ColorableTool = "pen" | "highlighter";
export const COLORABLE_TOOLS: ColorableTool[] = ["pen", "highlighter"];
export const COLORABLE_TOOL_LABELS: Record<ColorableTool, string> = {
	pen: "Pen",
	highlighter: "Highlighter",
};

/** Plafond de couleurs récentes, propre à chaque outil — le surligneur sert moins souvent de teintes variées que le crayon, sa liste de récents doit rester plus courte. */
export const MAX_RECENT_COLORS: Record<ColorableTool, number> = {
	pen: 6,
	highlighter: 4,
};

/** Palette par défaut du stylo : teintes sombres et saturées, lisibles sur papier clair. */
export const DEFAULT_PEN_PALETTE = ["#1a1a1a", "#d64545", "#e08a2c", "#2f9e56", "#2f6fd6", "#8a4fd6"];
/** Palette par défaut du surligneur : distincte du stylo — jaune, vert, rose et bleu fluo, clairs et saturés comme un vrai surligneur. */
export const DEFAULT_HIGHLIGHTER_PALETTE = ["#f9ec1a", "#7cfc00", "#ff6fb0", "#3ecbf0"];

/**
 * Couleurs pour un outil donné : la couleur active courante, la palette
 * principale (personnalisable — un clic long ou un clic droit remplace une
 * teinte définitivement), et les couleurs récemment utilisées via le
 * sélecteur libre (la plus récente en premier).
 */
export interface ToolColors {
	active: string;
	palette: string[];
	recent: string[];
}

/** Indexé par outil : le stylo et le surligneur ont chacun leur palette et leurs récents, jamais partagés (des teintes vives de surligneur ne conviennent pas au stylo, et inversement). */
export type ToolColorSettings = Record<ColorableTool, ToolColors>;

/**
 * Préférences de l'utilisateur pour l'outil de dessin. Ce sont des réglages
 * du plugin, pas des propriétés d'un document .draw : ils survivent à la
 * fermeture de l'onglet via loadData()/saveData(), indépendamment du fichier
 * ouvert. `size` sert à la fois d'épaisseur de trait (stylo/surligneur) et
 * de taille de gomme (voir ERASER_RADIUS_SCALE dans view.ts) : c'est le même
 * réglage à trois crans réutilisé par la barre d'outils, comme demandé.
 *
 * `defaultBackground`/`defaultDensity` ne s'appliquent qu'à la création
 * d'une nouvelle feuille (voir createEmptyDrawing, model.ts) : une fois
 * créées, le fond et la densité d'une feuille sont des propriétés du
 * document (Drawing.background/density), pas de ces réglages.
 */
export interface QuillStoneSettings {
	tool: ActiveTool;
	/**
	 * Outil actif imposé à l'ouverture d'une feuille (voir DrawView.onOpen),
	 * indépendamment de `tool` — qui continue de suivre le dernier outil
	 * choisi pendant la session, y compris une gomme. Utile pour qui passe
	 * son temps à réorganiser des schémas plutôt qu'à écrire : le curseur
	 * peut ainsi être actif dès l'ouverture, sans avoir à le resélectionner
	 * à chaque fois.
	 */
	defaultTool: DefaultTool;
	colors: ToolColorSettings;
	size: number;
	/**
	 * Réordonne le rendu pour que les surligneurs passent toujours sous le
	 * stylo, quel que soit l'ordre de création. Désactivé par défaut : l'ordre
	 * chronologique (transparence, pas réordonnancement) est le comportement
	 * attendu d'une prise de notes.
	 */
	highlighterAlwaysBehind: boolean;
	/**
	 * Force un papier clair même en thème sombre. Activé par défaut : c'est
	 * le seul moyen d'obtenir un surlignage correct (multiply) sans délaver
	 * l'encre en dessous — sur papier sombre, l'alternative (screen) éclaircit
	 * aussi le texte qu'elle recouvre.
	 */
	paperAlwaysLight: boolean;
	/** Fond appliqué aux nouvelles feuilles créées depuis Obsidian. */
	defaultBackground: BackgroundKind;
	/** Densité appliquée aux nouvelles feuilles (grid/lines/dots uniquement). */
	defaultDensity: Density;
	/**
	 * Fond appliqué aux nouvelles PAGES ajoutées avec le bouton + à l'intérieur
	 * d'une feuille déjà ouverte (voir DrawView.addPage) — distinct de
	 * `defaultBackground`, qui ne concerne que la toute première page d'une
	 * feuille nouvellement créée depuis Obsidian. Une feuille de cours et les
	 * pages qu'on y ajoute en cours de route n'ont pas forcément le même fond
	 * par défaut (un cours qui commence en Seyès peut vouloir des pages
	 * blanches pour des schémas ensuite, sans avoir à le rechoisir à chaque +).
	 */
	newPageBackground: BackgroundKind;
	/** Orientation des nouvelles pages ajoutées avec le bouton + — voir newPageBackground. */
	newPageOrientation: Orientation;
	/**
	 * Convertit un trait de stylo/surligneur en segment droit après un appui
	 * immobile prolongé (voir DrawView.armStillnessTimer). Désactivable :
	 * gênant pour qui écrit lentement, où une pause en cours de lettre
	 * resterait quasi immobile assez longtemps pour déclencher la conversion.
	 * Maj dès le pointerdown produit toujours une ligne droite immédiate,
	 * indépendamment de ce réglage — c'est un geste volontaire, pas automatique.
	 */
	straightenOnHold: boolean;
	/** Durée d'immobilité (ms) avant la conversion en ligne droite. */
	straightenHoldDelayMs: number;
}

export const DEFAULT_SETTINGS: QuillStoneSettings = {
	tool: "pen",
	defaultTool: "pen",
	colors: {
		// Papier clair par défaut (paperAlwaysLight) : encre par défaut noire, pas blanche, sinon le texte est invisible.
		pen: { active: DEFAULT_PEN_PALETTE[0], palette: [...DEFAULT_PEN_PALETTE], recent: [] },
		highlighter: {
			active: DEFAULT_HIGHLIGHTER_PALETTE[0],
			palette: [...DEFAULT_HIGHLIGHTER_PALETTE],
			recent: [],
		},
	},
	size: 4,
	highlighterAlwaysBehind: false,
	paperAlwaysLight: true,
	defaultBackground: "grid",
	defaultDensity: "normal",
	newPageBackground: "grid",
	newPageOrientation: "portrait",
	straightenOnHold: true,
	straightenHoldDelayMs: 600,
};

function cloneDefaultSettings(): QuillStoneSettings {
	return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as QuillStoneSettings;
}

/**
 * Fusionne les données chargées (loadData()) avec les valeurs par défaut,
 * sans jamais partager de référence avec DEFAULT_SETTINGS (un
 * Object.assign superficiel copierait la même sous-structure `colors` par
 * référence, et la modifier — un remplacement de teinte, par exemple —
 * muterait alors la constante par défaut elle-même). Migre aussi en douceur
 * l'ancien format à plat (penColor/highlighterColor) vers colors.*.active,
 * pour ne pas perdre la dernière couleur d'un utilisateur déjà installé.
 */
export function mergeSettings(loaded: unknown): QuillStoneSettings {
	const settings = cloneDefaultSettings();
	if (!loaded || typeof loaded !== "object") return settings;

	const data = loaded as Record<string, unknown> & { penColor?: string; highlighterColor?: string };
	Object.assign(settings, data);

	if (!data.colors) {
		settings.colors = cloneDefaultSettings().colors;
		if (typeof data.penColor === "string") settings.colors.pen.active = data.penColor;
		if (typeof data.highlighterColor === "string") settings.colors.highlighter.active = data.highlighterColor;
	}

	return settings;
}

export class QuillStoneSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: QuillStonePlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Default tool on open")
			.setDesc(
				"The tool active as soon as a sheet opens, regardless of the last tool used. The cursor suits someone mostly rearranging existing diagrams rather than writing."
			)
			.addDropdown((dropdown) => {
				for (const tool of DEFAULT_TOOL_OPTIONS) dropdown.addOption(tool, DEFAULT_TOOL_LABELS[tool]);
				dropdown.setValue(this.plugin.settings.defaultTool);
				dropdown.onChange(async (value) => {
					this.plugin.settings.defaultTool = value as DefaultTool;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Highlighter always in the background")
			.setDesc(
				"Highlighter strokes are rendered before pen strokes, regardless of their creation order. Disabled, the order is chronological: a highlighter stroke drawn after a pen stroke appears on top, translucent."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.highlighterAlwaysBehind).onChange(async (value) => {
					this.plugin.settings.highlighterAlwaysBehind = value;
					await this.plugin.saveSettings();
					this.plugin.refreshOpenDrawViews();
				})
			);

		new Setting(containerEl)
			.setName("Paper always light")
			.setDesc(
				"Keeps the paper light even in dark theme, for reliable highlighting (the highlighter darkens without washing out the ink underneath). Disabled, the paper follows the theme and the highlighter automatically chooses between darkening and lightening based on its luminance."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.paperAlwaysLight).onChange(async (value) => {
					this.plugin.settings.paperAlwaysLight = value;
					await this.plugin.saveSettings();
					this.plugin.refreshOpenDrawViews();
				})
			);

		new Setting(containerEl)
			.setName("Default background")
			.setDesc("Background applied to new sheets created from Obsidian.")
			.addDropdown((dropdown) => {
				for (const kind of BACKGROUND_KINDS) dropdown.addOption(kind, BACKGROUND_LABELS[kind]);
				dropdown.setValue(this.plugin.settings.defaultBackground);
				dropdown.onChange(async (value) => {
					this.plugin.settings.defaultBackground = value as BackgroundKind;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Default density")
			.setDesc(
				"Grid spacing for the grid/lines/dots backgrounds of new sheets (no effect on Seyès, staff, or isometric, whose proportions are fixed)."
			)
			.addDropdown((dropdown) => {
				for (const density of DENSITIES) dropdown.addOption(density, DENSITY_LABELS[density]);
				dropdown.setValue(this.plugin.settings.defaultDensity);
				dropdown.onChange(async (value) => {
					this.plugin.settings.defaultDensity = value as Density;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("New page background")
			.setDesc(
				"Background applied to a new page added with the + button inside a sheet that's already open — distinct from the default background above, which only applies to the very first page of a newly created sheet."
			)
			.addDropdown((dropdown) => {
				for (const kind of BACKGROUND_KINDS) dropdown.addOption(kind, BACKGROUND_LABELS[kind]);
				dropdown.setValue(this.plugin.settings.newPageBackground);
				dropdown.onChange(async (value) => {
					this.plugin.settings.newPageBackground = value as BackgroundKind;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("New page orientation")
			.setDesc("Orientation of a new page added with the + button inside a sheet that's already open.")
			.addDropdown((dropdown) => {
				dropdown.addOption("portrait", "Portrait");
				dropdown.addOption("landscape", "Landscape");
				dropdown.setValue(this.plugin.settings.newPageOrientation);
				dropdown.onChange(async (value) => {
					this.plugin.settings.newPageOrientation = value as Orientation;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Straighten on hold")
			.setDesc(
				"A pen or highlighter stroke held still converts into a straight segment. Holding Shift from the start of the stroke always produces an immediate straight line, regardless of this setting — disabling it only prevents the automatic conversion, which can get in the way for slow writers."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.straightenOnHold).onChange(async (value) => {
					this.plugin.settings.straightenOnHold = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Delay before conversion")
			.setDesc("How long a stroke must stay still, in milliseconds, before it converts into a straight line.")
			.addSlider((slider) =>
				slider
					.setLimits(300, 1500, 50)
					.setValue(this.plugin.settings.straightenHoldDelayMs)
					.onChange(async (value) => {
						this.plugin.settings.straightenHoldDelayMs = value;
						await this.plugin.saveSettings();
					})
			);

		this.displayColorSection(containerEl);
	}

	/**
	 * Une palette par outil, éditable directement : cliquer une pastille
	 * ouvre le sélecteur maison (voir colorPicker.ts — le même composant que
	 * la barre d'outils, pas un `<input type="color">` natif) et remplace
	 * cette teinte, avec un aperçu immédiat. Chaque bordure de pastille (voir
	 * styles.css) reste visible quelle que soit la couleur choisie, y compris
	 * blanc sur fond clair — l'aperçu de la teinte ne doit jamais se fondre
	 * dans son entourage.
	 */
	private displayColorSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Colors").setHeading();

		for (const tool of COLORABLE_TOOLS) {
			const label = COLORABLE_TOOL_LABELS[tool];

			new Setting(containerEl)
				.setName(`Palette — ${label}`)
				.setDesc("Click a swatch to replace it.");

			const swatchesEl = containerEl.createDiv({ cls: "quillstone-settings-swatches" });
			this.renderPaletteEditor(swatchesEl, tool);

			new Setting(containerEl)
				.setName(`Reset the ${label.toLowerCase()} palette`)
				.setDesc("Restore this palette's default colors (recently used colors are unaffected).")
				.addButton((button) =>
					button.setButtonText("Reset").onClick(async () => {
						const defaults = tool === "pen" ? DEFAULT_PEN_PALETTE : DEFAULT_HIGHLIGHTER_PALETTE;
						this.plugin.settings.colors[tool].palette = [...defaults];
						await this.plugin.saveSettings();
						this.plugin.refreshOpenDrawViews();
						swatchesEl.empty();
						this.renderPaletteEditor(swatchesEl, tool);
					})
				);
		}
	}

	private renderPaletteEditor(container: HTMLElement, tool: ColorableTool): void {
		const palette = this.plugin.settings.colors[tool].palette;
		palette.forEach((color, index) => {
			const swatch = container.createDiv({ cls: "quillstone-settings-swatch" });
			swatch.setCssStyles({ backgroundColor: color });
			swatch.setAttribute("aria-label", `${color} — click to edit`);
			swatch.addEventListener("click", () => {
				openColorPicker({
					anchor: swatch,
					initialColor: color,
					onCommit: (newColor) => {
						void (async () => {
							this.plugin.settings.colors[tool].palette[index] = newColor;
							await this.plugin.saveSettings();
							this.plugin.refreshOpenDrawViews();
							swatch.setCssStyles({ backgroundColor: newColor });
							swatch.setAttribute("aria-label", `${newColor} — click to edit`);
						})();
					},
				});
			});
		});
	}
}
