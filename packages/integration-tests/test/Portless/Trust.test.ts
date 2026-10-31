import { TrustLive } from "@alchemy.run/portless/internal/Trust";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

const { test } = Test.make({ providers: Layer.empty });

/**
 * The step that trusts the CA is the one that asks the operating system for
 * permission, so it is tested against stand-ins for the tools it runs: `security` (macOS) or
 * `openssl` (Linux) answers "is it trusted?", and Portless's `trust` command is a script
 * that records that it ran. Nothing here touches the real trust store.
 */
const supported = process.platform === "darwin" || process.platform === "linux";
const verifier = process.platform === "darwin" ? "security" : "openssl";

const scenario = (
  trustCommand: "establish" | "fail" | "ignore",
  body: (input: {
    readonly ensure: Effect.Effect<void, { readonly _tag: string }, any>;
    readonly calls: Effect.Effect<ReadonlyArray<string>, never, any>;
    readonly establish: Effect.Effect<void, never, any>;
  }) => Effect.Effect<void, unknown, any>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-portless-trust-" });
    const bin = path.join(directory, "bin");
    const trusted = path.join(directory, "trusted");
    const callsFile = path.join(directory, "calls");
    const certificateAuthority = path.join(directory, "ca.pem");
    const cli = path.join(directory, "cli.mjs");
    yield* fs.makeDirectory(bin);
    yield* fs.writeFileString(
      certificateAuthority,
      "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
    );
    const script = (name: string, source: string) =>
      fs
        .writeFileString(path.join(bin, name), `#!/bin/sh\n${source}\n`)
        .pipe(Effect.andThen(fs.chmod(path.join(bin, name), 0o755)));
    // Trusted exactly while the marker file exists.
    yield* script(verifier, `[ -f "${trusted}" ]`);
    // Chromium's database on Linux: present, and already holding the CA.
    yield* script("certutil", `case "$*" in *" -a"*) cat "${certificateAuthority}";; esac`);
    yield* fs.writeFileString(
      cli,
      `import { appendFileSync, writeFileSync } from "node:fs";
       appendFileSync(${JSON.stringify(callsFile)}, process.argv[2] + "\\n");
       ${trustCommand === "establish" ? `writeFileSync(${JSON.stringify(trusted)}, "");` : ""}
       ${trustCommand === "fail" ? `console.error("keychain denied"); process.exit(1);` : ""}`,
    );

    // The tools are found on PATH, and Chromium's database under HOME.
    const environment = { PATH: `${bin}:${process.env.PATH}`, HOME: directory };
    const previous = Object.fromEntries(
      Object.keys(environment).map((key) => [key, process.env[key]]),
    );
    yield* Effect.acquireRelease(
      Effect.sync(() => Object.assign(process.env, environment)),
      () =>
        Effect.sync(() => {
          for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }),
    );

    yield* body({
      ensure: TrustLive.ensure({
        node: "node",
        cli,
        stateDirectory: directory,
        certificateAuthority,
      }),
      calls: fs.readFileString(callsFile).pipe(
        Effect.map((text) => text.split("\n").filter((line) => line !== "")),
        Effect.orElseSucceed(() => []),
      ),
      establish: fs.writeFileString(trusted, "").pipe(Effect.orDie),
    });
  }).pipe(Effect.scoped);

test.skipIf(!supported)(
  "a CA that is already trusted prompts for nothing",
  scenario("establish", ({ ensure, calls, establish }) =>
    Effect.gen(function* () {
      yield* establish;
      yield* ensure;
      yield* ensure;
      expect(yield* calls).toEqual([]);
    }),
  ),
  { exclusive: true },
);

test.skipIf(!supported)(
  "an untrusted CA is trusted once, then verified, and a second run prompts for nothing",
  scenario("establish", ({ ensure, calls }) =>
    Effect.gen(function* () {
      yield* ensure;
      expect(yield* calls).toEqual(["trust"]);
      yield* ensure;
      expect(yield* calls).toEqual(["trust"]);
    }),
  ),
  { exclusive: true },
);

test.skipIf(!supported)(
  "a failing `portless trust` is reported with what it printed",
  scenario("fail", ({ ensure, calls }) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(ensure);
      expect(error._tag).toBe("ProxyTrustFailed");
      expect(error).toMatchObject({ exitCode: 1 });
      expect(JSON.stringify(error)).toContain("keychain denied");
      expect(yield* calls).toEqual(["trust"]);
    }),
  ),
  { exclusive: true },
);

test.skipIf(!supported)(
  "a CA that is still untrusted after `portless trust` is an error",
  scenario("ignore", ({ ensure }) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(ensure);
      expect(error._tag).toBe("ProxyTrustNotEstablished");
    }),
  ),
  { exclusive: true },
);
