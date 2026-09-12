import { Stroke } from "./model";
import { StrokeBounds } from "./render";

/** Un rectangle englobant pivotable — tout ce dont rotatedRectCorners/imageIntersectsMarquee ont besoin, satisfait aussi bien par ImageElement que par ShapeElement (model.ts) sans dépendre de l'un ou l'autre par son nom. */
interface RotatedBox {
	x: number;
	y: number;
	width: number;
	height: number;
	rotation: number;
}

/**
 * Géométrie pure pour l'outil sélection : test d'appartenance (lasso/rectangle),
 * intersections de boîtes, rotation/mise à l'échelle de points. Comme
 * render.ts/model.ts, ce module ne connaît rien d'Obsidian.
 */

export interface Point {
	x: number;
	y: number;
}

/** Proportion minimale des points d'un trait devant tomber dans la zone pour qu'il soit sélectionné — l'écriture manuscrite déborde presque toujours d'un geste de sélection, un critère "entièrement contenu" serait inutilisable. */
export const STROKE_SELECTION_RATIO = 0.6;

export type Marquee = { mode: "rect"; bounds: StrokeBounds } | { mode: "lasso"; points: Point[] };

export function boundsOfPoints(points: Point[]): StrokeBounds {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of points) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	return { minX, minY, maxX, maxY };
}

export function boundsIntersect(a: StrokeBounds, b: StrokeBounds): boolean {
	return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function pointInRect(px: number, py: number, rect: StrokeBounds): boolean {
	return px >= rect.minX && px <= rect.maxX && py >= rect.minY && py <= rect.maxY;
}

/** Ray-casting pair-crossing (règle pair-impair), le test point-polygone standard. */
export function pointInPolygon(px: number, py: number, poly: Point[]): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const xi = poly[i].x;
		const yi = poly[i].y;
		const xj = poly[j].x;
		const yj = poly[j].y;
		const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
		if (intersects) inside = !inside;
	}
	return inside;
}

export function marqueeBounds(marquee: Marquee): StrokeBounds {
	return marquee.mode === "rect" ? marquee.bounds : boundsOfPoints(marquee.points);
}

export function marqueeContainsPoint(marquee: Marquee, x: number, y: number): boolean {
	return marquee.mode === "rect" ? pointInRect(x, y, marquee.bounds) : pointInPolygon(x, y, marquee.points);
}

/** Proportion des points du trait tombant dans la zone — comparer au seuil STROKE_SELECTION_RATIO à l'appelant. */
export function strokeSelectionRatio(stroke: Stroke, marquee: Marquee): number {
	if (stroke.points.length === 0) return 0;
	let count = 0;
	for (const p of stroke.points) {
		if (marqueeContainsPoint(marquee, p[0], p[1])) count++;
	}
	return count / stroke.points.length;
}

/**
 * "L'intersection avec la zone suffit" pour un élément à boîte pivotable —
 * une image, ou une forme "rectangle"/"ellipse" (voir RotatedBox : les deux
 * ont la même géométrie x/y/width/height/rotation). Pour "ligne"/"flèche"
 * (width/height signés, voir ShapeElement), cette même approximation par
 * boîte reste utilisée telle quelle — moins précise pour un lasso qui
 * frôlerait le trait sans toucher sa boîte englobante, mais évite un vrai
 * test segment/polygone pour un cas marginal. Pour un rectangle (mode
 * "rect"), le simple recoupement des boîtes déjà utilisé comme pré-filtre
 * suffit. Pour un lasso, un vrai clip de polygone serait disproportionné
 * ici : on approxime en testant si le centre ou un coin de l'élément tombe
 * dans le polygone, ou si un point du tracé du lasso tombe dans sa boîte —
 * couvre les cas réels (lasso qui recoupe l'élément, ou entièrement contenu
 * dedans) sans algorithme de clipping complet.
 */
export function imageIntersectsMarquee(el: RotatedBox, marquee: Marquee, imageBounds: StrokeBounds): boolean {
	if (!boundsIntersect(marqueeBounds(marquee), imageBounds)) return false;
	if (marquee.mode === "rect") return true;

	const cx = el.x + el.width / 2;
	const cy = el.y + el.height / 2;
	if (pointInPolygon(cx, cy, marquee.points)) return true;

	for (const corner of rotatedRectCorners(el)) {
		if (pointInPolygon(corner.x, corner.y, marquee.points)) return true;
	}
	for (const p of marquee.points) {
		if (pointInRect(p.x, p.y, imageBounds)) return true;
	}
	return false;
}

export function rotatedRectCorners(el: RotatedBox): Point[] {
	const cx = el.x + el.width / 2;
	const cy = el.y + el.height / 2;
	const hw = el.width / 2;
	const hh = el.height / 2;
	return ([
		[-hw, -hh],
		[hw, -hh],
		[hw, hh],
		[-hw, hh],
	] as [number, number][]).map(([dx, dy]) => rotatePointAround(cx + dx, cy + dy, cx, cy, el.rotation));
}

export function rotatePointAround(x: number, y: number, cx: number, cy: number, angleDeg: number): Point {
	const rad = (angleDeg * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const dx = x - cx;
	const dy = y - cy;
	return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}
