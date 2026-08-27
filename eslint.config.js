// @ts-check
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-unused-vars": "off",
      // JSON API responses, catch-block errors, and SDK interop points are
      // legitimately untyped throughout this codebase (matching clio-mcp's
      // own style, which has no lint config at all and uses `any` freely
      // in exactly these spots).
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    ignores: ["build/**", "node_modules/**", "coverage/**"],
  },
];
