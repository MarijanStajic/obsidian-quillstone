/**
 * Résolu par esbuild.config.mjs (virtualPdfWorkerSourcePlugin), jamais par
 * Node/tsc directement : le code source du Worker pdf.js, capturé au build
 * et injecté comme chaîne dans main.js — voir src/pdf.ts:configurePdfWorker.
 */
declare module "virtual:pdf-worker-source" {
	const source: string;
	export default source;
}
