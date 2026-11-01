import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { noBuiltFunctions } from "../Functions/helpers.ts";
import { hostingFor } from "./fixtures/stack.ts";
import { liveOptions, logLevel } from "./site.ts";

const { test } = Test.make({ providers: Stackit.providers() });

describe.skipIf(noBuiltFunctions)("Stackit.Website.ServerImage", () => {
  test.provider(
    "pushes a build pinned by digest, and only a new build pushes again",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dist = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-image-stackit-" });
        const clientDir = path.join(dist, "client");
        yield* fs.makeDirectory(path.join(dist, "server"), { recursive: true });
        yield* fs.makeDirectory(clientDir, { recursive: true });
        const serverEntry = path.join(dist, "server", "serve-node.mjs");
        yield* fs.writeFileString(serverEntry, `console.log("v1");\n`);
        yield* fs.writeFileString(path.join(clientDir, "robots.txt"), "User-agent: *\n");

        const app = Effect.gen(function* () {
          const hosting = yield* hostingFor("server-image");
          const image = yield* Stackit.Website.ServerImage("Image", {
            serverEntry,
            distDir: dist,
            clientDir,
            repository: hosting.registry.repository,
            username: hosting.registry.username,
            password: hosting.registry.password,
          });
          return { image };
        });

        const first = yield* stack.deploy(app);
        const repository = first.image.repository;
        expect(first.image.image.startsWith(`${repository}@sha256:`)).toBe(true);
        expect(Object.keys(first.image.purgeable)).toEqual(["/robots.txt"]);

        // An unchanged build pushes nothing.
        const unchanged = yield* stack.plan(app);
        expect(unchanged.resources.Image).toMatchObject({ action: "noop" });

        // A changed file surfaces in the plan though the props are the same, as a new digest.
        yield* fs.writeFileString(serverEntry, `console.log("v2");\n`);
        const pending = yield* stack.plan(app);
        expect(pending.resources.Image).toMatchObject({ action: "update" });
        const second = yield* stack.deploy(app);
        expect(second.image.image).not.toEqual(first.image.image);
        expect(second.image.codeHash).not.toEqual(first.image.codeHash);

        yield* stack.destroy();
      }).pipe(logLevel),
    liveOptions(),
  );
});
