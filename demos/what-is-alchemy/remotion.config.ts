import { Config } from "@remotion/cli/config";

// Snippets are imported as text (`./x.ts?raw`), as Vite does for the presenter.
Config.overrideWebpackConfig((config) => ({
  ...config,
  module: {
    ...config.module,
    rules: [{ resourceQuery: /raw/, type: "asset/source" }, ...(config.module?.rules ?? [])],
  },
}));
