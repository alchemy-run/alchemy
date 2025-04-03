# Bundle

The Bundle component lets you create and manage bundled JavaScript/TypeScript files using [esbuild](https://esbuild.github.io/).

# Minimal Example

Bundle a TypeScript file for Node.js.

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

# Create a Minified Browser Bundle

```ts
import { Bundle } from "alchemy/esbuild";

const bundle = await Bundle("app", {
  entryPoint: "src/app.ts",
  outfile: "dist/app.min.js",
  format: "iife",
  platform: "browser",
  minify: true,
  sourcemap: true,
  target: ["es2020", "chrome58", "firefox57", "safari11"]
});
```

# Bundle with External Dependencies

```ts
import { Bundle } from "alchemy/esbuild";

const bundle = await Bundle("lambda", {
  entryPoint: "src/lambda.ts",
  outdir: "dist",
  format: "cjs",
  platform: "node",
  external: ["aws-sdk", "sharp"],
  options: {
    banner: {
      js: "/* Generated bundle */"
    }
  }
});
```