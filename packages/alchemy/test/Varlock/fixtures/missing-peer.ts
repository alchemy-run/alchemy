import { resolveVarlockEntry } from "@/Varlock/SecretManager.ts";
import * as Effect from "effect/Effect";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";

const isolatedRequire = createRequire(
  path.join(os.tmpdir(), "alchemy-varlock-peer-isolation", "package.json"),
);

Effect.runPromise(
  // The repository installs Varlock as a development dependency, and Bun can
  // resolve packages from its global cache even from an isolated directory.
  // Resolve a guaranteed-absent stand-in to exercise the same native
  // MODULE_NOT_FOUND path the optional peer takes in a consuming project.
  resolveVarlockEntry(() =>
    isolatedRequire.resolve("varlock-alchemy-optional-peer-probe"),
  ).pipe(Effect.flip),
).then((error) => {
  console.log(
    JSON.stringify({
      tag: error._tag,
      message: error.message,
    }),
  );
});
