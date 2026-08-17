import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // `site/` is the mkdocs build output and `.venv-docs/` the Python venv that builds it — both are
  // created by following docs/README.md's local-preview instructions, and both are already in
  // .gitignore. ESLint does NOT read .gitignore, so they have to be named again here; without this,
  // `npm run lint` drowns in thousands of errors from minified vendor bundles and site-packages JS
  // (2353 of them, against ~0 from this repo's own code) and is useless as a signal.
  { ignores: ["dist/", "node_modules/", "site/", ".venv-docs/", "src/api/schema.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
