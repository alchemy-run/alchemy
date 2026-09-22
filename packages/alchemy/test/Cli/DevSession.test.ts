import type { DevSessionOptions } from "@/Cli/DevSession.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

interface Claim {
  owned?: boolean;
  pid?: number;
  nonce?: string;
  error?: string;
}

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "dev-session-",
    directory: process.platform === "win32" ? undefined : "/tmp",
  });
  const main = path.join(directory, "stack.ts");
  yield* fs.writeFileString(
    main,
    "throw new Error('must not evaluate stack');",
  );
  const home = path.join(directory, "home");
  let sequence = 0;
  const options: DevSessionOptions = {
    main,
    cwd: directory,
    stage: "test",
    force: false,
  };
  const launch = Effect.fn(function* (
    overrides: Partial<DevSessionOptions> = {},
    fail = false,
    cancel = false,
    shellProfile = "session-profile",
  ) {
    const id = sequence++;
    const result = path.join(directory, `result-${id}.json`);
    const stop = path.join(directory, `stop-${id}`);
    const fixture = yield* path.fromFileUrl(
      new URL("./fixtures/dev-session.ts", import.meta.url),
    );
    const handle = yield* ChildProcess.make("bun", ["run", fixture], {
      env: {
        ALCHEMY_HOME: home,
        ALCHEMY_PROFILE: shellProfile,
        SESSION_INPUT: JSON.stringify({
          options: { ...options, ...overrides },
          result,
          stop,
          fail,
          cancel,
        }),
      },
      extendEnv: true,
      forceKillAfter: "2 seconds",
      stdout: "ignore",
      stderr: "inherit",
    });
    const read = fs.exists(result).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("25 millis"),
        until: Boolean,
        times: 400,
      }),
      Effect.andThen(fs.readFileString(result)),
      Effect.map((text) => JSON.parse(text) as Claim),
    );
    return {
      handle,
      read,
      stop: fs
        .writeFileString(stop, "stop")
        .pipe(Effect.andThen(handle.exitCode)),
    };
  });
  const recordFile = Effect.gen(function* () {
    const records = yield* fs.readDirectory(path.join(home, "dev-sessions"));
    expect(records).toHaveLength(1);
    return path.join(home, "dev-sessions", records[0]!);
  });
  return { fs, path, directory, main, home, launch, recordFile };
});

const local = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(PlatformServices));

test.live(
  "concurrent claim burst has one owner; duplicates cannot release it",
  () =>
    local(
      Effect.gen(function* () {
        const { launch, fs, recordFile } = yield* setup;
        const children = yield* Effect.forEach(
          Array.from({ length: 6 }),
          () => launch(),
          { concurrency: "unbounded" },
        );
        const claims = yield* Effect.forEach(children, (child) => child.read, {
          concurrency: "unbounded",
        });
        expect(claims.filter((claim) => claim.owned)).toHaveLength(1);
        const index = claims.findIndex((claim) => claim.owned);
        const owner = claims[index]!;
        expect(claims.every((claim) => claim.pid === owner.pid)).toBe(true);
        yield* Effect.forEach(
          children.filter((_, i) => i !== index),
          (child) => child.handle.exitCode,
        );
        const file = yield* recordFile;
        expect(JSON.parse(yield* fs.readFileString(file)).nonce).toBe(
          owner.nonce,
        );
        yield* children[index]!.stop;
        expect(yield* fs.exists(file)).toBe(false);
        const replacement = yield* launch();
        expect((yield* replacement.read).owned).toBe(true);
        yield* replacement.stop;
      }),
    ),
  { tags: ["local"], timeout: 30_000 },
);

test.live.skipIf(process.platform === "win32")(
  "canonical entry aliases and sorted filters reuse the owner; stale mtime is not death",
  () =>
    local(
      Effect.gen(function* () {
        const { launch, fs, path, directory, main, recordFile } = yield* setup;
        const alias = path.join(directory, "alias.ts");
        yield* fs.symlink(main, alias);
        const owner = yield* launch({
          include: ["B", "A", "A"],
          exclude: ["D", "C"],
        });
        const first = yield* owner.read;
        const file = yield* recordFile;
        const old = yield* Effect.sync(() => new Date(0));
        yield* fs.utimes(file, old, old);
        const duplicate = yield* launch({
          main: "./alias.ts",
          include: ["A", "B"],
          exclude: ["C", "D", "D"],
        });
        expect(yield* duplicate.read).toEqual({
          owned: false,
          pid: first.pid,
          nonce: first.nonce,
        });
        yield* duplicate.handle.exitCode;
        expect(yield* fs.exists(file)).toBe(true);
        yield* owner.stop;
      }),
    ),
  { tags: ["local"], timeout: 30_000 },
);

test.live(
  "different entrypoints and stages are independent",
  () =>
    local(
      Effect.gen(function* () {
        const { launch, fs, path, directory } = yield* setup;
        const other = path.join(directory, "other.ts");
        yield* fs.writeFileString(other, "");
        const children = yield* Effect.all([
          launch(),
          launch({ stage: "other" }),
          launch({ main: other }),
        ]);
        for (const child of children)
          expect((yield* child.read).owned).toBe(true);
        yield* Effect.forEach(children, (child) => child.stop, {
          concurrency: "unbounded",
        });
      }),
    ),
  { tags: ["local"], timeout: 30_000 },
);

test.live(
  "conflicting cwd, profile, env file, force and filters fail without changing ownership",
  () =>
    local(
      Effect.gen(function* () {
        const { launch, fs, path, directory, recordFile } = yield* setup;
        const cwd = path.join(directory, "nested");
        const envFile = path.join(directory, "other.env");
        yield* fs.makeDirectory(cwd);
        yield* fs.writeFileString(envFile, "SECRET=never-persist-this\n");
        const owner = yield* launch();
        yield* owner.read;
        const file = yield* recordFile;
        const before = yield* fs.readFileString(file);
        for (const overrides of [
          { cwd },
          { profile: "other" },
          { envFile },
          { force: true },
          { include: ["A"] },
          { exclude: ["A"] },
        ]) {
          const conflict = yield* launch(overrides);
          expect((yield* conflict.read).error).toContain("conflicting options");
          yield* conflict.handle.exitCode;
          expect(yield* fs.readFileString(file)).toBe(before);
        }
        expect(before).not.toContain("never-persist-this");
        yield* owner.stop;
      }),
    ),
  { tags: ["local"], timeout: 30_000 },
);

test.live(
  "profile selection distinguishes explicit overrides and inherited shell values",
  () =>
    local(
      Effect.gen(function* () {
        const { launch, fs, recordFile } = yield* setup;
        const owner = yield* launch({}, false, false, "first");
        yield* owner.read;
        const file = yield* recordFile;
        const before = yield* fs.readFileString(file);
        for (const conflict of [
          yield* launch({}, false, false, "second"),
          yield* launch({ profile: "first" }, false, false, "first"),
        ]) {
          expect((yield* conflict.read).error).toContain(
            "conflicting options: profile",
          );
          yield* conflict.handle.exitCode;
          expect(yield* fs.readFileString(file)).toBe(before);
        }
        yield* owner.stop;
        const explicit = yield* launch(
          { profile: "fixed" },
          false,
          false,
          "first",
        );
        const claim = yield* explicit.read;
        const duplicate = yield* launch(
          { profile: "fixed" },
          false,
          false,
          "second",
        );
        expect(yield* duplicate.read).toEqual({ ...claim, owned: false });
        yield* duplicate.handle.exitCode;
        yield* explicit.stop;
      }),
    ),
  { tags: ["local"], timeout: 30_000 },
);

test.live(
  "explicit dotenv selection conflicts with implicit dotenv precedence",
  () =>
    local(
      Effect.gen(function* () {
        const { launch, fs, path, directory, recordFile } = yield* setup;
        const envFile = path.join(directory, ".env");
        yield* fs.writeFileString(envFile, "VALUE=dotenv\n");
        const owner = yield* launch();
        yield* owner.read;
        const file = yield* recordFile;
        const before = yield* fs.readFileString(file);
        const explicit = yield* launch({ envFile });
        expect((yield* explicit.read).error).toContain(
          "conflicting options: envFile",
        );
        yield* explicit.handle.exitCode;
        expect(yield* fs.readFileString(file)).toBe(before);
        yield* owner.stop;
      }),
    ),
  { tags: ["local"], timeout: 30_000 },
);

test.live.skipIf(process.platform === "win32")(
  "explicit dotenv aliases reuse the same owner",
  () =>
    local(
      Effect.gen(function* () {
        const { launch, fs, path, directory } = yield* setup;
        const envFile = path.join(directory, ".env");
        yield* fs.writeFileString(envFile, "VALUE=dotenv\n");
        const explicitOwner = yield* launch({ envFile });
        const first = yield* explicitOwner.read;
        const alias = path.join(directory, "alias.env");
        yield* fs.symlink(envFile, alias);
        const duplicate = yield* launch({ envFile: alias });
        expect(yield* duplicate.read).toEqual({
          owned: false,
          pid: first.pid,
          nonce: first.nonce,
        });
        yield* duplicate.handle.exitCode;
        yield* explicitOwner.stop;
      }),
    ),
  { tags: ["local"], timeout: 30_000 },
);

test.live(
  "failed setup releases ownership",
  () =>
    local(
      Effect.gen(function* () {
        const { launch } = yield* setup;
        const failed = yield* launch({}, true);
        expect((yield* failed.read).error).toBe("setup failed");
        yield* failed.handle.exitCode;
        const next = yield* launch();
        expect((yield* next.read).owned).toBe(true);
        yield* next.stop;
      }),
    ),
  { tags: ["local"], timeout: 30_000 },
);

test.live(
  "dead process records are reclaimed; stale finalizers cannot remove successors",
  () =>
    local(
      Effect.gen(function* () {
        const { launch, fs, recordFile } = yield* setup;
        const first = yield* launch();
        yield* first.read;
        const file = yield* recordFile;
        const saved = JSON.parse(yield* fs.readFileString(file));
        yield* first.stop;
        yield* fs.writeFileString(file, JSON.stringify(saved));
        const successor = yield* launch();
        const second = yield* successor.read;
        expect(second.owned).toBe(true);
        expect(second.nonce).not.toBe(saved.nonce);
        const replacement = {
          ...JSON.parse(yield* fs.readFileString(file)),
          nonce: "successor-nonce",
        };
        yield* fs.writeFileString(file, JSON.stringify(replacement));
        yield* successor.stop;
        expect(JSON.parse(yield* fs.readFileString(file)).nonce).toBe(
          "successor-nonce",
        );
      }),
    ),
  { tags: ["local"], timeout: 30_000 },
);

test.live(
  "stale metadata locks block contenders until explicitly recovered",
  () =>
    local(
      Effect.gen(function* () {
        const { launch, fs, path, home, recordFile } = yield* setup;
        const owner = yield* launch();
        yield* owner.read;
        const file = yield* recordFile;
        yield* owner.stop;
        const key = path.basename(file, ".json");
        const lock = path.join(home, "lock", `dev-session-${key}.lock`);
        yield* fs.makeDirectory(lock);
        yield* fs.writeFileString(path.join(lock, "owner"), "abandoned");
        const stale = yield* Effect.sync(() => new Date(0));
        yield* fs.utimes(lock, stale, stale);
        const contenders = [yield* launch(), yield* launch()];
        for (const contender of contenders) {
          expect((yield* contender.read).error).toContain("Timed out waiting");
          yield* contender.handle.exitCode;
        }
        expect(yield* fs.exists(file)).toBe(false);
        expect(yield* fs.readFileString(path.join(lock, "owner"))).toBe(
          "abandoned",
        );
        yield* fs.remove(lock, { recursive: true });
        const recovered = yield* launch();
        expect((yield* recovered.read).owned).toBe(true);
        yield* recovered.stop;
      }),
    ),
  { tags: ["local"], timeout: 30_000 },
);

test.live(
  "corrupt and unrecognized records fail closed",
  () =>
    local(
      Effect.gen(function* () {
        const { launch, fs, recordFile } = yield* setup;
        const owner = yield* launch();
        yield* owner.read;
        const file = yield* recordFile;
        const saved = yield* fs.readFileString(file);
        yield* owner.stop;
        for (const content of [
          "not-json",
          JSON.stringify({ ...JSON.parse(saved), version: 99 }),
        ]) {
          yield* fs.writeFileString(file, content);
          const refused = yield* launch();
          expect((yield* refused.read).error).toContain(
            "corrupt dev-session record",
          );
          yield* refused.handle.exitCode;
          expect(yield* fs.readFileString(file)).toBe(content);
        }
      }),
    ),
  { tags: ["local"], timeout: 30_000 },
);

test.live(
  "interrupting a duplicate claim does not release the live owner",
  () =>
    local(
      Effect.gen(function* () {
        const { launch, fs, recordFile } = yield* setup;
        const owner = yield* launch();
        const claim = yield* owner.read;
        const duplicate = yield* launch({}, false, true);
        expect((yield* duplicate.read).owned).toBe(false);
        yield* duplicate.handle.exitCode;
        const file = yield* recordFile;
        expect(JSON.parse(yield* fs.readFileString(file)).nonce).toBe(
          claim.nonce,
        );
        yield* owner.stop;
      }),
    ),
  { tags: ["local"], timeout: 30_000 },
);

test.live(
  "interruption after acquisition releases the owner's record",
  () =>
    local(
      Effect.gen(function* () {
        const { launch } = yield* setup;
        const interrupted = yield* launch({}, false, true);
        expect((yield* interrupted.read).owned).toBe(true);
        yield* interrupted.handle.exitCode;
        const successor = yield* launch();
        expect((yield* successor.read).owned).toBe(true);
        yield* successor.stop;
      }),
    ),
  { tags: ["local"], timeout: 30_000 },
);
