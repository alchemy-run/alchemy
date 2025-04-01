# Bundle

The Bundle component allows you to create and manage bundled JavaScript/TypeScript files using [esbuild](https://esbuild.github.io/). It supports various output formats, sourcemaps, and platform targets.

# Minimal Example

```ts twoslash
import { Bundle } from "alchemy/esbuild";

const bundle = await Bundle("my-bundle", {
  entryPoint: "src/index.ts",
  outdir: "dist",
  format: "esm",
  platform: "node",
  target: "node18"
});
//  ^?
```

# Create the Bundle

```ts twoslash
import { Bundle } from "alchemy/esbuild";

const bundle = await Bundle("handler", {
  entryPoint: "src/handler.ts",
  outdir: ".alchemy/.out",
  format: "esm",
  platform: "node",
  target: "node18",
  minify: true,
  sourcemap: "external",
  external: ["aws-sdk"]
});
//  ^?
```