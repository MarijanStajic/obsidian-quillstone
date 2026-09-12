import esbuild from "esbuild";
import process from "process";
import { readFile } from "node:fs/promises";
import { builtinModules as builtins } from "node:module";

const prod = process.argv[2] === "production";

// pdf.js fait tourner son analyse dans un Worker dédié, qui a besoin de son
// propre script. Obsidian ne télécharge que main.js/manifest.json/styles.css
// depuis une release (voir obsidian-releases:README, "How community plugins
// are pulled") : un pdf.worker.js séparé n'atteindrait donc jamais le coffre
// d'un utilisateur ayant installé le plugin normalement. On bundle donc ce
// Worker une première fois, à part et en mémoire (write: false), puis on
// injecte son code source comme chaîne dans main.js via un plugin esbuild
// (voir virtualPdfWorkerSourcePlugin ci-dessous) — src/pdf.ts le charge au
// runtime via un Blob URL (voir configurePdfWorker), sans jamais dépendre
// d'un second fichier sur disque.
const workerResult = await esbuild.build({
  entryPoints: ["node_modules/pdfjs-dist/build/pdf.worker.mjs"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  logLevel: "info",
  sourcemap: false,
  write: false,
  minify: prod,
});
const pdfWorkerSource = workerResult.outputFiles[0].text;

/** Résout l'import virtuel "virtual:pdf-worker-source" (voir src/pdf.ts et son .d.ts) vers le code du Worker pdf.js capturé ci-dessus, sans jamais l'écrire sur disque. */
const virtualPdfWorkerSourcePlugin = {
  name: "virtual-pdf-worker-source",
  setup(build) {
    build.onResolve({ filter: /^virtual:pdf-worker-source$/ }, (args) => ({
      path: args.path,
      namespace: "virtual-pdf-worker-source",
    }));
    build.onLoad({ filter: /.*/, namespace: "virtual-pdf-worker-source" }, () => ({
      contents: `export default ${JSON.stringify(pdfWorkerSource)};`,
      loader: "js",
    }));
  },
};

/**
 * jsPDF (voir src/pdfExport.ts) inclut, dans le même fichier que le reste de
 * son API, un mode de sortie qu'on n'appelle jamais (`output("pdfobjectnewwindow")`)
 * qui injecte dynamiquement un <script> pointant vers un CDN externe pour
 * prévisualiser le PDF dans une fenêtre. esbuild ne peut pas retirer une
 * seule branche d'un switch à l'arbre : ce code mort finit donc dans main.js
 * tel quel, où l'analyse statique d'Obsidian le signale comme injection de
 * script à l'exécution — à raison, même si ce plugin ne déclenche jamais ce
 * chemin. On neutralise ce seul appel à la source, avant le bundling. Si une
 * mise à jour de jsPDF change cette ligne, ce plugin échoue bruyamment
 * plutôt que de laisser passer l'injection en silence.
 */
const patchJsPdfScriptInjectionPlugin = {
  name: "patch-jspdf-script-injection",
  setup(build) {
    build.onLoad({ filter: /jspdf[\\/]dist[\\/]jspdf\.es(\.min)?\.js$/ }, async (args) => {
      const original = await readFile(args.path, "utf8");
      // Anchor sur la forme de l'expression, pas sur un nom de variable
      // minifié (instable d'un build de jsPDF à l'autre) : "<qqch>.document.createElement("script")".
      const pattern = /[\w$]+\.document\.createElement\("script"\)/g;
      const matches = original.match(pattern) ?? [];
      if (matches.length !== 1) {
        throw new Error(
          `patch-jspdf-script-injection: expected exactly one match in ${args.path}, found ${matches.length} — jsPDF's internals likely changed, review before rebuilding.`
        );
      }
      const patched = original.replace(
        pattern,
        '(() => { throw new Error("pdfobjectnewwindow output is disabled in this build."); })()'
      );
      return { contents: patched, loader: "js" };
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  plugins: [virtualPdfWorkerSourcePlugin, patchJsPdfScriptInjectionPlugin],
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

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
