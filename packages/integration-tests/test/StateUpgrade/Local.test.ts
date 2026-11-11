import { describe, expect, it } from "@alchemy.run/test";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import {
  current,
  deployArgs,
  fails,
  MAIN,
  planLine,
  released,
  RELEASED,
  succeeds,
  workdir,
  type RunOptions,
} from "./Harness.ts";
import { expectPlaintext, expectSealed, secretsOfTexts, STACK } from "./Records.ts";

/** Every state file of a stage, by file name. */
const stageFiles = Effect.fn(function* (cwd: string, stage: string) {
  const fs = yield* FileSystem.FileSystem;
  const dir = `${cwd}/.alchemy/state/${STACK}/${stage}`;
  const files = new Map<string, string>();
  for (const file of yield* fs.readDirectory(dir)) {
    if (file.endsWith(".json")) files.set(file, yield* fs.readFileString(`${dir}/${file}`));
  }
  return files;
});

const PASSPHRASE = "state upgrade test passphrase";

describe(`local state written by ${RELEASED}`, { tags: ["local"] }, () => {
  it.effect(
    "stays readable by both versions, and seals and unseals with the passphrase layer",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* workdir("local");
        const old = yield* released();
        const next = yield* current();
        const on = (overrides: Record<string, string> = {}): RunOptions => ({
          cwd,
          env: { UPGRADE_STORE: "local", ...overrides },
        });
        const withPassphrase = (encryption: string, passphrase = PASSPHRASE) =>
          on({ UPGRADE_ENCRYPTION: encryption, ALCHEMY_STATE_PASSPHRASE: passphrase });

        yield* succeeds(old, deployArgs("one"), on());
        const original = yield* stageFiles(cwd, "one");
        expect([...original.keys()].sort()).toEqual([
          "Secret.json",
          "Token.json",
          "__stack_output__.json",
        ]);
        const secrets = secretsOfTexts(original.values());
        expect(secrets).toHaveLength(4);

        // Without a layer the new version keeps the files as they are, and
        // records the store's format next to them.
        const upgraded = yield* succeeds(next, deployArgs("one"), on());
        expect(planLine(upgraded)).toBe("Plan: no changes");
        expect(yield* stageFiles(cwd, "one")).toEqual(original);
        expect(JSON.parse(yield* fs.readFileString(`${cwd}/.alchemy/state.format.json`))).toEqual({
          format: 1,
        });

        // The released version still deploys it, and its `state` commands,
        // which list every entry of the state directory as a stack, still
        // walk the whole store.
        const stillOld = yield* succeeds(old, deployArgs("one"), on());
        expect(planLine(stillOld)).toBe("Plan: no changes");
        expect(yield* fs.readDirectory(`${cwd}/.alchemy/state`)).toEqual([STACK]);
        const listed = yield* succeeds(old, ["state", "ls", "--recursive", "-c", MAIN], on());
        for (const fqn of ["Secret", "Token"]) expect(listed.output).toContain(fqn);
        const read = yield* succeeds(old, ["state", "cat", "--recursive", "-c", MAIN], on());
        for (const secret of secrets) expect(read.output).toContain(secret);

        // The passphrase layer seals the stage as it deploys.
        const sealing = yield* succeeds(next, deployArgs("one"), withPassphrase("passphrase"));
        expect(planLine(sealing)).toBe("Plan: no changes");
        const sealed = yield* stageFiles(cwd, "one");
        expect([...sealed.keys()].sort()).toEqual([...original.keys()].sort());
        expectSealed(sealed.values(), secrets);

        // A sealed stage fails without the right key, and nothing writes to it.
        yield* fails(old, deployArgs("one"), on());
        const unlayered = yield* fails(next, deployArgs("one"), on());
        expect(unlayered.output).toContain("disable: true");
        const wrong = yield* fails(next, deployArgs("one"), withPassphrase("passphrase", "wrong"));
        expect(wrong.output).toContain("wrong passphrase");
        expect(yield* stageFiles(cwd, "one")).toEqual(sealed);

        // `disable` decrypts it, and the released version deploys it again.
        yield* succeeds(next, deployArgs("one"), withPassphrase("passphrase-disable"));
        const decrypted = yield* stageFiles(cwd, "one");
        expectPlaintext(decrypted.values());
        expect(secretsOfTexts(decrypted.values())).toEqual(secrets);
        const downgraded = yield* succeeds(old, deployArgs("one"), on());
        expect(planLine(downgraded)).toBe("Plan: no changes");
      }).pipe(Effect.provide(PlatformServices)),
    { timeout: 300_000 },
  );
});
