import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    // __fixtures__ hold child-process protocol stubs spawned by tests —
    // plain-Node CJS scripts, not app code. release/ is electron-builder
    // output; its extraResources and asar-unpacked modules are real .js/.cjs
    // files on disk that eslint would otherwise sweep.
    ignores: [
      "dist/**",
      "node_modules/**",
      "renderer/dist/**",
      "release/**",
      "main/**/__fixtures__/**",
      // Persistent e2e caches (matplotlib font cache, uv package cache) —
      // the uv cache contains third-party .js sources once populated.
      "e2e/.fixtures-cache/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["renderer/src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      // Unused vars are an error (dead imports/bindings rot silently);
      // prefix with _ to intentionally keep an unused binding.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Node-environment build scripts (ESM). Provide the Node globals they use.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
);
