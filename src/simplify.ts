import { Pt } from "./model";

/** Distance perpendiculaire d'un point à la droite (infinie) passant par lineStart et lineEnd. */
function perpendicularDistance(point: Pt, lineStart: Pt, lineEnd: Pt): number {
	const [x, y] = point;
	const [x1, y1] = lineStart;
	const [x2, y2] = lineEnd;
	const dx = x2 - x1;
	const dy = y2 - y1;
	const lenSq = dx * dx + dy * dy;
	if (lenSq === 0) return Math.hypot(x - x1, y - y1);

	const numerator = Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1);
	return numerator / Math.sqrt(lenSq);
}

/**
 * Ramer-Douglas-Peucker : réduit une polyligne en supprimant les points qui
 * s'écartent de moins de `tolerance` (repère logique de la page) de la
 * droite reliant leurs voisins conservés. Une capture haute fréquence produit
 * énormément de points quasi alignés le long d'un trait droit ou d'une
 * courbe douce ; on en retire couramment 70% sans différence visible, ce qui
 * allège aussi bien la régénération du cache de rendu que la taille du
 * fichier .draw enregistré (voir view.ts:finishStroke, appelé au pointerup).
 */
export function simplifyPoints(points: Pt[], tolerance: number): Pt[] {
	if (points.length <= 2) return points;

	let maxDist = 0;
	let index = 0;
	const end = points.length - 1;
	for (let i = 1; i < end; i++) {
		const dist = perpendicularDistance(points[i], points[0], points[end]);
		if (dist > maxDist) {
			maxDist = dist;
			index = i;
		}
	}

	if (maxDist > tolerance) {
		const left = simplifyPoints(points.slice(0, index + 1), tolerance);
		const right = simplifyPoints(points.slice(index), tolerance);
		return left.slice(0, -1).concat(right);
	}

	return [points[0], points[end]];
}
