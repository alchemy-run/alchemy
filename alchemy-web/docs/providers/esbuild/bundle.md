# Bundle

The Bundle component lets you create and manage bundled JavaScript/TypeScript files using [esbuild](https://esbuild.github.io/).

# Minimal Example

Bundle a TypeScript file for Node.js with default settings.

```ts
import { Bundle } from "alchemy/esbuild";

const bundle = await Bundle("handler", {
  entryPoint: "src/handler.ts",
  outdir: ".alchemy/.out"
});
```

# Bundle with Custom Configuration 

Configure the bundle format, target environment, and other build options.

```ts
import { Bundle } from "alchemy/esbuild";

const bundle = await Bundle("handler", {
  entryPoint: "src/handler.ts",
  outdir: ".alchemy/.out",
  format: "esm",
  platform: "node", 
  target: "node18",
  minify: true,
  sourcemap: "external",
  external: ["aws-sdk"],
  options: {
    // Additional esbuild options
    logLevel: "info"
  }
});
```

# Bundle for Browser

Create a browser-compatible bundle with IIFE format.

```ts
import { Bundle } from "alchemy/esbuild";

const bundle = await Bundle("app", {
  entryPoint: "src/app.ts",
  outfile: "dist/app.js",
  format: "iife",
  platform: "browser",
  target: ["es2020", "chrome58"],
  minify: true,
  sourcemap: true
});
```