# Bundle

The Bundle component allows you to create and manage bundled JavaScript/TypeScript files using [esbuild](https://esbuild.github.io/). It supports various output formats, sourcemaps, and platform targets.

# Minimal Example

```ts
import { Bundle } from "alchemy/esbuild";

const bundle = await Bundle("my-bundle", {
  entryPoint: "src/index.ts",
  outdir: "dist",
  format: "esm",
  platform: "node",
  target: "node18"
});
```

# Create the Bundle

```ts
import { Bundle } from "alchemy/esbuild";

const bundle = await Bundle("app-bundle", {
  entryPoint: "src/app.ts",
  outfile: "build/app.js",
  format: "cjs",
  platform: "node",
  target: ["node16", "es2020"],
  minify: true,
  sourcemap: "external",
  external: ["express"],
  options: {
    define: { "process.env.NODE_ENV": '"production"' }
  }
});
```