# Bundle

The Bundle Resource lets you bundle JavaScript and TypeScript files using [esbuild](https://esbuild.github.io/).

# Minimal Example

Bundle a TypeScript file for Node.js.

```ts
import { Bundle } from "alchemy/esbuild";

const bundle = await Bundle("handler", {
  entryPoint: "src/handler.ts",
  outdir: ".alchemy/.out",
  format: "esm",
  platform: "node"
});
```

# Bundle with Source Maps

Create a bundle with source maps for debugging.

```ts
import { Bundle } from "alchemy/esbuild";

const bundle = await Bundle("app", {
  entryPoint: "src/app.ts",
  outfile: "dist/app.js",
  sourcemap: true,
  minify: true,
  format: "iife",
  platform: "browser"
});
```

# Bundle with External Dependencies

Bundle code while excluding certain dependencies.

```ts
import { Bundle } from "alchemy/esbuild";

const bundle = await Bundle("lambda", {
  entryPoint: "src/lambda.ts",
  outdir: "dist",
  format: "cjs",
  platform: "node",
  target: "node18",
  external: ["aws-sdk", "sharp"]
});
```