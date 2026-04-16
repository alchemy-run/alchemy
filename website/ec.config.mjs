import { defineEcConfig } from "@astrojs/starlight/expressive-code";
import ecTwoSlash from "expressive-code-twoslash";
import { twoslashErrorTransform } from "./plugins/twoslash-error-transform.mjs";

const baseUrl = new URL("../", import.meta.url).pathname;

export default defineEcConfig({
  themes: ["github-light", "github-dark-dimmed"],
  plugins: [
    ecTwoSlash({
      instanceConfigs: {
        twoslash: {
          explicitTrigger: true,
          languages: ["ts", "tsx", "typescript"],
        },
      },
      twoslashOptions: {
        customTags: ["error", "warn", "log", "annotate"],
        compilerOptions: {
          moduleResolution: /** @type {any} */ (100), // Bundler
          module: /** @type {any} */ (99), // ESNext
          target: /** @type {any} */ (9), // ES2022
          strict: true,
          baseUrl,
          paths: {
            alchemy: ["./alchemy/src/index.ts"],
            "alchemy/*": ["./alchemy/src/*"],
          },
        },
      },
    }),
    twoslashErrorTransform(),
  ],
});
