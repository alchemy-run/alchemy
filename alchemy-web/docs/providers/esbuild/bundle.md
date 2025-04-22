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

# Bundle with Output Directory

Specify an output directory and additional build options:

```ts
import { Bundle } from "alchemy/esbuild";

const bundle = await Bundle("api", {
  entryPoint: "src/api.ts", 
  outdir: ".build",
  format: "esm",
  platform: "node",
  target: "node18",
  minify: true,
  sourcemap: true
});
```

# Bundle with External Dependencies

Exclude packages from the bundle:

```ts
import { Bundle } from "alchemy/esbuild";

const bundle = await Bundle("app", {
  entryPoint: "src/app.ts",
  format: "esm",
  external: ["aws-sdk", "lodash"],
  platform: "node"
});
```