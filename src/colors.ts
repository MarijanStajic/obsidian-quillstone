import { RenderColors } from "./render";

/**
 * Résout les couleurs de rendu (papier, réglure) à partir des variables CSS
 * du thème actif, avec le réglage « Papier toujours clair ». Partagé entre
 * la vue d'édition (view.ts) et les miniatures intégrées dans les notes
 * (embed.ts) : les deux doivent afficher le surligneur de façon cohérente.
 */
export function resolveColors(el: HTMLElement, paperAlwaysLight: boolean): RenderColors {
	const styles = getComputedStyle(el);
	if (paperAlwaysLight) {
		return {
			paper: styles.getPropertyValue("--qs-paper-light").trim() || "#ffffff",
			rule: styles.getPropertyValue("--qs-rule-light").trim() || "#c3d4ec",
		};
	}
	return {
		paper: styles.getPropertyValue("--qs-paper").trim() || "#ffffff",
		rule: styles.getPropertyValue("--qs-rule").trim() || "#c9d6e8",
	};
}
