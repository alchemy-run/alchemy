# Bundle

The Bundle component allows you to create and manage bundled JavaScript/TypeScript files using [esbuild](https://esbuild.github.io/). It supports various output formats, sourcemaps, and platform targets.

# Minimal Example

```ts
import { Bundle } from "alchemy/esbuild";

const bundle = await Bundle("handler", {
  entryPoint: "src/handler.ts",
  outdir: ".alchemy/.out",
  format: "esm",
  platform: "node",
  target: "node18"
});
```

# Create the Bundle

```ts
import { Bundle } from "alchemy/esbuild";

const bundle = await Bundle("app", {
  entryPoint: "src/app.ts",
  outfile: "dist/app.js",
  format: "cjs",
  platform: "node",
  target: "node16",
  minify: true,
  sourcemap: "external",
  external: ["express"],
  options: {
    define: { "process.env.NODE_ENV": '"production"' }
  }
});
```