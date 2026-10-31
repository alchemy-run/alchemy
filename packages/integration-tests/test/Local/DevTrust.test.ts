import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@alchemy.run/test";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Stream from "effect/Stream";
import { CALLER_CA, PROVIDER_CA } from "./fixtures/test-cas.ts";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/dev-trust/", import.meta.url));
const ALCHEMY_BIN = fileURLToPath(new URL("../../../alchemy/bin/alchemy.js", import.meta.url));

describe.skipIf(process.platform === "win32" || process.env.FAST)(
  "alchemy dev trust",
  { tags: ["local"] },
  () => {
    it.live(
      "gives a Command.Dev child one bundle of the caller's CA and the AWS emulator's",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "dev-trust-" });
          const caller = path.join(tmp, "caller.pem");
          const out = path.join(tmp, "out.json");
          yield* fs.writeFileString(caller, CALLER_CA);
          // The AWS provider contributes the emulator's CA from the home directory.
          const home = path.join(tmp, "home");
          yield* fs.makeDirectory(path.join(home, ".floci"), { recursive: true });
          yield* fs.writeFileString(path.join(home, ".floci", "ca.pem"), PROVIDER_CA);

          // `ALCHEMY_DEV_ONCE` stops the CLI once the first apply has converged.
          const cli = yield* ChildProcess.make(
            "bun",
            [ALCHEMY_BIN, "dev", "alchemy.run.ts", "--stage", "dev-trust"],
            {
              cwd: FIXTURE_DIR,
              stdout: "pipe",
              stderr: "pipe",
              env: {
                CI: "1",
                HOME: home,
                ALCHEMY_DEV_ONCE: "1",
                NODE_EXTRA_CA_CERTS: caller,
                DEV_TRUST_OUT: out,
              },
              extendEnv: true,
            },
          );
          const output = yield* Effect.all(
            [cli.stdout, cli.stderr].map((stream) =>
              stream.pipe(Stream.decodeText, Stream.mkString),
            ),
            { concurrency: "unbounded" },
          );
          const exitCode = yield* cli.exitCode;
          expect(exitCode, output.join("\n")).toBe(0);

          const seen = JSON.parse(yield* fs.readFileString(out)) as {
            contributed: string | undefined;
            bundle: string | undefined;
            certificates: string | undefined;
          };
          // The sidecar inherited what the CLI published (other providers may
          // add their own files)...
          expect(seen.contributed?.split(delimiter)).toContain(path.join(home, ".floci", "ca.pem"));
          // ...and the child's one bundle holds both CAs.
          expect(seen.bundle).not.toBe(caller);
          expect(seen.certificates).toContain(CALLER_CA.trim());
          expect(seen.certificates).toContain(PROVIDER_CA.trim());
        }).pipe(Effect.provide(PlatformServices), Effect.scoped),
      { timeout: 120_000 },
    );
  },
);
