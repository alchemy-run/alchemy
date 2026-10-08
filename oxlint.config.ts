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
    "effecttsgo",
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
    "demos/**",
    "**/fixtures/**",
    "**/*.test.ts",
  ],
  rules: {
    "require-yield": "off",
    "no-irregular-whitespace": "off",
    "typescript/no-misused-new": "off",
    // TODO: fix all violations of this
    "typescript/no-non-null-asserted-optional-chain": "off",
    "effecttsgo/any-unknown-in-error-context": "off",
    "effecttsgo/unstable-api-usage": "off",
    "effecttsgo/instance-of-schema": "warn",
    "effecttsgo/nested-effect-gen-yield": "warn",
    "effecttsgo/new-schema-class": "warn",
    "effecttsgo/schema-sync": "warn",
    "effecttsgo/service-not-as-class": "warn",
    "effecttsgo/unnecessary-arrow-block": "warn",
  },
} satisfies OxlintConfig);
