import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // `site/` is the mkdocs build output (docs/README.md tells contributors to build it
  // locally); without this, `npm run lint` drowns in minified vendor bundles.
  { ignores: ["dist/", "node_modules/", "site/", "src/api/schema.d.ts"] },
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
