import { defineConfig, type OxlintConfig } from "oxlint";

export default defineConfig({
  options: {
    reportUnusedDisableDirectives: "warn",
    typeAware: true,
    typeCheck: false,
  },
  plugins: [
    "import",
    // TODO: enable and clean up violations of these plugins
    // "effecttsgo",
    // "typescript",
    "node",
    "unicorn",
    "oxc",
  ],
  ignorePatterns: [
    "submodules/**",
    "packages/alchemy/test/**",
    "packages/alchemy-test/**",
    "examples/**",
    "**/fixtures/**",
    "**/*.test.ts",
  ],
  rules: {
    "require-yield": "off",
    "no-irregular-whitespace": "off",
    "typescript/no-misused-new": "off",
    // TODO: fix all violations of this
    "typescript/no-non-null-asserted-optional-chain": "off",
  },
} satisfies OxlintConfig);
