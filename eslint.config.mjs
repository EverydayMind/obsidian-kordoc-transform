import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
export default defineConfig([
  { ignores: ['node_modules/**', 'main.js', '*.mjs', 'scripts/**'] },
  ...obsidianmd.configs.recommended,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
]);
