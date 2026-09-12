import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
});

// pdf.js fait tourner son analyse dans un Worker dédié : un script classique
// autonome, séparé de main.js, jamais chargé par require()/import (voir
// src/pdf.ts, qui pointe GlobalWorkerOptions.workerSrc dessus via le chemin
// du dossier du plugin). Bundlé à part en IIFE : c'est un script de Worker,
// pas un module — il s'auto-enregistre en lisant les globales de son propre
// contexte d'exécution.
const workerContext = await esbuild.context({
  entryPoints: ["node_modules/pdfjs-dist/build/pdf.worker.mjs"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  logLevel: "info",
  sourcemap: false,
  outfile: "pdf.worker.js",
  minify: prod,
});

if (prod) {
  await context.rebuild();
  await workerContext.rebuild();
  process.exit(0);
} else {
  await context.watch();
  await workerContext.watch();
}
