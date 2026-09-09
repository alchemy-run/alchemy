import { rewriteEmittedTypes } from "@/Prisma/ORM/internal.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

const describe = layer(NodeServices.layer);

const writeDts = (contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({
      prefix: "alchemy-prisma-rewrite-",
    });
    const dtsPath = path.join(dir, "contract.d.ts");
    yield* fs.writeFileString(dtsPath, contents);
    return dtsPath;
  });

describe("rewriteEmittedTypes", (it) => {
  it.effect(
    "maps leaked @internal/extension-* specifiers to @prisma/orm-extension-*",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Imports already use the public package. Prisma still writes the
        // unpublished @internal/extension-* name as a string in the type
        // body (through 8.0.0-rc.8).
        const dtsPath = yield* writeDts(`
import type { Vector } from "@prisma/orm-extension-pgvector/codec-types";
type Pgvector = { package: "@internal/extension-pgvector/codec-types" };
type Parade = { package: "@internal/extension-paradedb/pack" };
`);
        yield* rewriteEmittedTypes(dtsPath);
        const dts = yield* fs.readFileString(dtsPath);
        expect(dts).not.toContain("@internal/");
        expect(dts).toContain('"@prisma/orm-extension-pgvector/codec-types"');
        expect(dts).toContain('"@prisma/orm-extension-paradedb/pack"');
      }),
  );

  it.effect(
    "still maps postgres @internal/* prefixes when an extension specifier is present",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dtsPath = yield* writeDts(`
import type { X } from "@internal/adapter-postgres/operation-types";
import type { Y } from "@internal/contract/types";
type Pack = { package: "@internal/extension-pgvector/pack" };
`);
        yield* rewriteEmittedTypes(dtsPath);
        const dts = yield* fs.readFileString(dtsPath);
        expect(dts).not.toContain("@internal/");
        expect(dts).toContain("@prisma/orm-postgres/adapter/operation-types");
        expect(dts).toContain("@prisma/orm-postgres/contract/types");
        expect(dts).toContain("@prisma/orm-extension-pgvector/pack");
      }),
  );

  it.effect("fails when an unmapped @internal/* specifier remains", () =>
    Effect.gen(function* () {
      const dtsPath = yield* writeDts(
        `type Leak = { package: "@internal/unknown-pkg/types" };\n`,
      );
      const result = yield* Effect.result(rewriteEmittedTypes(dtsPath));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure)).toContain("@internal/unknown-pkg/");
      }
    }),
  );
});
