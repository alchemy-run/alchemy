import { transformTypesFlags } from "@/Util/Node.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { fileURLToPath } from "node:url";

const nodePath = typeof Bun !== "undefined" ? Bun.which("node") : null;
const nodeFlags = transformTypesFlags();

// Pins buildless node dev end to end: the register-dev-mode hooks must
// (1) resolve the monorepo's own packages through their `bun` export
// condition onto src/ — otherwise the CLI runs from src while a user's
// stack (which imports `alchemy`) resolves built lib/, splitting the
// process across two copies of the package — while leaving packages
// without a `bun` condition (published sigil) on their built output, and
// (2) transpile `.tsx`, which node's type stripping refuses.
it.live.skipIf(nodePath === null || nodeFlags.length === 0)(
  "dev-mode hooks resolve monorepo packages to src and transpile tsx",
  () =>
    Effect.gen(function* () {
      const packageDir = fileURLToPath(new URL("../..", import.meta.url));
      const script = `
        console.log("alchemy=" + import.meta.resolve("alchemy"));
        console.log("sub=" + import.meta.resolve("alchemy/Cloudflare"));
        console.log("sigil=" + import.meta.resolve("@alchemy.run/sigil"));
        await import("./src/Cli/components/view/Runtime.tsx");
        console.log("tsx=ok");
      `;
      const handle = yield* ChildProcess.make(
        nodePath!,
        [
          ...nodeFlags,
          "--import",
          "./bin/register-dev-mode.js",
          "--input-type=module",
          "-e",
          script,
        ],
        {
          cwd: packageDir,
          env: { NO_COLOR: "1" },
          extendEnv: true,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          killSignal: "SIGKILL",
        },
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(
            Stream.decodeText,
            Stream.runCollect,
            Effect.map((chunks) => chunks.join("")),
          ),
          handle.stderr.pipe(
            Stream.decodeText,
            Stream.runCollect,
            Effect.map((chunks) => chunks.join("")),
          ),
          handle.exitCode,
        ],
        { concurrency: 3 },
      );
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout).toMatch(/alchemy=file:.*\/src\/index\.ts/);
      expect(stdout).toMatch(/sub=file:.*\/src\/Cloudflare\/index\.ts/);
      // No `bun` condition on the published package — built output stays.
      expect(stdout).toMatch(/sigil=file:.*\/dist\/index\.js/);
      expect(stdout).toContain("tsx=ok");
    }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
  { timeout: 60_000 },
);
