import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as pathe from "pathe";

// Next.js' TypeScript setup requires the JS compiler API
// (`typescript/lib/typescript.js`). The workspace root pins typescript 7 —
// the native compiler, which no longer ships that file — so `next build` /
// `next dev` inside a cloned fixture would refuse to run ("do not have the
// required package(s) installed"). The `website` workspace pins typescript
// v6 (JS API), which bun nests at `website/node_modules/typescript` because
// it conflicts with the root's v7.
const jsApiTypescript = pathe.resolve(
  import.meta.dirname,
  "../../../../..",
  "website/node_modules/typescript",
);

/**
 * Give a cloned Next.js fixture its own `node_modules/typescript` symlink
 * pointing at a JS-API TypeScript, so Next's TypeScript verification and
 * build-time type check work despite the workspace pinning the native
 * (tsgo) compiler.
 */
export const linkJsApiTypeScript = Effect.fn(function* (rootDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const hasJsApi = yield* fs.exists(
    path.join(jsApiTypescript, "lib", "typescript.js"),
  );
  if (!hasJsApi) {
    return yield* Effect.die(
      new Error(
        `expected a JS-API TypeScript (lib/typescript.js) at ${jsApiTypescript}` +
          " — did the website workspace stop pinning a pre-native typescript?",
      ),
    );
  }

  yield* fs.makeDirectory(path.join(rootDir, "node_modules"), {
    recursive: true,
  });
  yield* fs.symlink(
    jsApiTypescript,
    path.join(rootDir, "node_modules", "typescript"),
  );
});
