# Bundle

The Bundle resource uses [esbuild](https://esbuild.github.io/) to bundle JavaScript and TypeScript files into optimized output.

# Minimal Example

Bundle a TypeScript file into an ESM module:

```ts
import { Bundle } from "alchemy/esbuild";

const bundle = await Bundle("handler", {
  entryPoint: "src/handler.ts",
  format: "esm"
});
```

# Node.js Bundle

Bundle a file specifically for Node.js with sourcemaps:

```ts
import { Bundle } from "alchemy/esbuild";

const bundle = await Bundle("api", {
  entryPoint: "src/api.ts",
  format: "cjs",
  platform: "node", 
  target: "node18",
  sourcemap: true,
  external: ["aws-sdk"]
});
```

# Browser Bundle

Create a minified browser bundle:

```ts
import { Bundle } from "alchemy/esbuild";

const bundle = await Bundle("app", {
  entryPoint: "src/app.ts",
  outfile: "dist/app.min.js",
  format: "iife",
  platform: "browser",
  target: ["es2020", "chrome58"],
  minify: true
});
```