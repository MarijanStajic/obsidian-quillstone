import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{ ignores: ["main.js", "node_modules/**", "esbuild.config.mjs", "eslint.config.mjs"] },
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
			},
		},
		rules: {
			// Noms propres affichés dans l'interface : jamais mis en minuscules.
			"obsidianmd/ui/sentence-case": [
				"warn",
				{ ignoreWords: ["QuillStone", "iPad", "Apple", "Pencil", "Scribble", "Settings", "Shift"] },
			],
		},
	},
]);
