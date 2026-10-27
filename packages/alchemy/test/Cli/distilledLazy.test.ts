import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Stream from "effect/Stream";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { nodePath, nodeSupportsDevMode } from "../nodeProbe.ts";

// A package whose exports answer `distilled-lazy` the way distilled's
// service modules do: the stub only under the condition, the full module
// otherwise.
const conditional = (name: string) =>
  JSON.stringify({
    name,
    type: "module",
    exports: {
      "./machines": { "distilled-lazy": "./lazy.js", default: "./full.js" },
    },
  });

// The published launcher under Node with the real `bin/register-oxc.js`:
// report which file each package resolves to, through `import` and
// `require`.
const resolved = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageDir = yield* path.fromFileUrl(new URL("../../", import.meta.url));
  const project = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-distilled-lazy-" });
  const installed = path.join(project, "node_modules", "alchemy");
  const bin = path.join(installed, "bin");
  yield* fs.makeDirectory(bin, { recursive: true });
  for (const file of ["cli.js", "register-oxc.js"])
    yield* fs.copyFile(path.join(packageDir, "bin", file), path.join(bin, file));
  yield* fs.symlink(path.join(packageDir, "node_modules"), path.join(installed, "node_modules"));
  yield* fs.writeFileString(
    path.join(installed, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  for (const name of ["@distilled.cloud/fly-io", "other"]) {
    const dir = path.join(project, "node_modules", name);
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path.join(dir, "package.json"), conditional(name));
    yield* fs.writeFileString(path.join(dir, "lazy.js"), 'export const file = "lazy";\n');
    yield* fs.writeFileString(path.join(dir, "full.js"), 'export const file = "full";\n');
  }
  yield* fs.writeFileString(
    path.join(bin, "alchemy.js"),
    [
      'import { createRequire } from "node:module";',
      `const require = createRequire(${JSON.stringify(path.join(project, "package.json"))});`,
      'const { file: distilled } = await import("@distilled.cloud/fly-io/machines");',
      'const { file: other } = await import("other/machines");',
      'const { file: required } = require("@distilled.cloud/fly-io/machines");',
      "console.log(JSON.stringify({ distilled, required, other }));",
      "",
    ].join("\n"),
  );
  const handle = yield* ChildProcess.make(nodePath!, [path.join(bin, "cli.js")], {
    cwd: project,
    env: { npm_execpath: "", npm_config_user_agent: "" },
    extendEnv: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    forceKillAfter: "1 second",
  });
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      handle.stdout.pipe(Stream.decodeText, Stream.mkString),
      handle.stderr.pipe(Stream.decodeText, Stream.mkString),
      handle.exitCode,
    ],
    { concurrency: 3 },
  );
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  return JSON.parse(stdout.trim());
}).pipe(Effect.scoped, Effect.provide(PlatformServices));

describe("distilled lazy service stubs", { tags: ["unit", "local"] }, () => {
  it.live.skipIf(!nodeSupportsDevMode)(
    "the CLI under Node opts in to distilled-lazy for @distilled.cloud packages only",
    () =>
      Effect.gen(function* () {
        expect(yield* resolved).toEqual({ distilled: "lazy", required: "lazy", other: "full" });
      }),
  );
});
