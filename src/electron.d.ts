/**
 * Déclarations minimales pour le sous-ensemble d'Electron utilisé par ce
 * plugin (presse-papier natif, voir view.ts:copySelectionToClipboard).
 * Le paquet "electron" complet n'est pas une dépendance du projet — il est
 * fourni par Obsidian à l'exécution (voir esbuild.config.mjs, "external") —
 * donc ses types ne sont pas disponibles sans l'installer. Ce fichier ne
 * couvre que ce dont ce plugin a besoin, pas l'API Electron entière.
 */
declare module "electron" {
	interface NativeImage {
		isEmpty(): boolean;
		toPNG(): Buffer;
	}

	export const nativeImage: {
		createFromDataURL(dataUrl: string): NativeImage;
	};

	export const clipboard: {
		writeText(text: string): void;
		readText(): string;
		write(data: { text?: string; image?: NativeImage }): void;
		readImage(): NativeImage;
	};
}
