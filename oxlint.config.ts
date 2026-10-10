import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import next from "ultracite/oxlint/next";

const agentAndVendorIgnores = [
  ".agent/**",
  ".agents/**",
  ".claude/**",
  ".codex/**",
  ".continue/**",
  ".cursor/**",
  ".gemini/**",
  ".github/**",
  ".omc/**",
  ".opencode/**",
  ".pi/**",
  ".roo/**",
  ".windsurf/**",
  "**/openwiki",
  "docs/**",
  "packages/ui/src/components/**",
  "tools/oxlint/anti-slop/**",
] as const;

/** Packages/apps with a direct `effect` dependency — Effect anti-slop rules stay scoped here. */
const effectPackageGlobs = [
  "apps/server/**/*.{ts,tsx}",
  "apps/worker/**/*.{ts,tsx}",
  "packages/api/**/*.{ts,tsx}",
  "packages/application/**/*.{ts,tsx}",
  "packages/connectors/**/*.{ts,tsx}",
  "packages/db/**/*.{ts,tsx}",
  "packages/domain/**/*.{ts,tsx}",
  "packages/env/**/*.{ts,tsx}",
  "packages/search/**/*.{ts,tsx}",
  "packages/performance/**/*.{ts,tsx}",
] as const;

export default defineConfig({
  extends: [core, next],
  ignorePatterns: [...core.ignorePatterns, ...agentAndVendorIgnores],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    {
      name: "anti-slop-effect",
      specifier: "./tools/oxlint/anti-slop/effect/index.ts",
    },
  ],
  overrides: [
    {
      files: [...effectPackageGlobs],
      rules: {
        "anti-slop-effect/no-service-constructor-imports": "error",
      },
    },
  ],
  rules: {
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
});
