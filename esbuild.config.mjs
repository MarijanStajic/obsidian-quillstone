import esbuild from "esbuild";
import process from "process";
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

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  plugins: [virtualPdfWorkerSourcePlugin],
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
