import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { withLock } from "../Auth/Lock.ts";
import { rootDir } from "../Auth/Paths.ts";
import { UserFacingError } from "../UserFacingError.ts";
import { writeFileAtomic } from "../Util/AtomicFile.ts";
import { initialCwd } from "../Util/Node.ts";
import { sha256 } from "../Util/sha256.ts";

const Options = Schema.Struct({
  cwd: Schema.String,
  profile: Schema.String,
  envFile: Schema.NullOr(
    Schema.Struct({ path: Schema.String, explicit: Schema.Boolean }),
  ),
  force: Schema.Boolean,
  include: Schema.Array(Schema.String),
  exclude: Schema.Array(Schema.String),
});

const Record = Schema.Struct({
  version: Schema.Literal(1),
  entrypoint: Schema.String,
  stage: Schema.String,
  pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  nonce: Schema.String.check(Schema.isNonEmpty()),
  options: Options,
});

export class DevSessionError extends Data.TaggedError("DevSessionError")<{
  readonly message: string;
}> {
  readonly [UserFacingError] = true;
}

export interface DevSessionOptions {
  readonly main: string;
  readonly stage: string;
  readonly cwd?: string;
  readonly profile?: string;
  readonly envFile?: string;
  readonly force: boolean;
  readonly include?: ReadonlyArray<string>;
  readonly exclude?: ReadonlyArray<string>;
}

const errno = Schema.is(Schema.Struct({ code: Schema.String }));

const isAlive = (pid: number) =>
  Effect.try({
    try: () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (errno(error) && error.code === "ESRCH") return false;
        throw error;
      }
    },
    catch: () =>
      new DevSessionError({
        message: `Cannot establish whether dev-session owner PID ${pid} is alive; refusing to take ownership.`,
      }),
  });

/** Acquire ownership without importing the stack or starting runtime services. */
export const acquireDevSession = Effect.fn(function* (
  input: DevSessionOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.realPath(input.cwd ?? initialCwd);
  const entrypoint = yield* fs.realPath(path.resolve(cwd, input.main));
  const envPath = path.resolve(cwd, input.envFile ?? ".env");
  const envFile =
    input.envFile !== undefined || (yield* fs.exists(envPath))
      ? {
          path: yield* fs.realPath(envPath),
          explicit: input.envFile !== undefined,
        }
      : null;
  const options = {
    cwd,
    profile: input.profile ?? "default",
    envFile,
    force: input.force,
    include: [...new Set(input.include ?? [])].sort(),
    exclude: [...new Set(input.exclude ?? [])].sort(),
  };
  const key = yield* sha256(JSON.stringify([entrypoint, input.stage]));
  const home = yield* Effect.sync(rootDir);
  const directory = path.join(home, "dev-sessions");
  const file = path.join(directory, `${key}.json`);
  const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    withLock(`dev-session-${key}`, effect, {
      timeout: "5 seconds",
      watchdog: false,
    });
  const read = fs.readFileString(file).pipe(
    Effect.flatMap((text) =>
      Effect.try(() => JSON.parse(text)).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Record, { onExcessProperty: "error" }),
        ),
        Effect.mapError(
          () =>
            new DevSessionError({
              message: `Unrecognized or corrupt dev-session record '${file}'; refusing to overwrite it.`,
            }),
        ),
      ),
    ),
    Effect.catchReason("PlatformError", "NotFound", () =>
      Effect.succeed(undefined),
    ),
  );

  return yield* Effect.acquireRelease(
    locked(
      Effect.gen(function* () {
        const previous = yield* read;
        if (previous !== undefined) {
          if (
            previous.entrypoint !== entrypoint ||
            previous.stage !== input.stage
          ) {
            return yield* new DevSessionError({
              message: `Dev-session identity mismatch in '${file}'; refusing to overwrite it.`,
            });
          }
          if (yield* isAlive(previous.pid)) {
            const conflicts = (
              Object.keys(options) as Array<keyof typeof options>
            ).filter(
              (key) =>
                JSON.stringify(options[key]) !==
                JSON.stringify(previous.options[key]),
            );
            if (conflicts.length > 0) {
              return yield* new DevSessionError({
                message: `Dev session for '${entrypoint}' (stage '${input.stage}') is owned by PID ${previous.pid} with conflicting options: ${conflicts.join(", ")}. Stop it in its original terminal before changing options.`,
              });
            }
            return {
              owned: false as const,
              pid: previous.pid,
              nonce: previous.nonce,
            };
          }
        }
        const owner = yield* Effect.sync(() => ({
          pid: process.pid,
          nonce: crypto.randomUUID(),
        }));
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* writeFileAtomic(
          fs,
          file,
          JSON.stringify({
            version: 1,
            entrypoint,
            stage: input.stage,
            ...owner,
            options,
          }),
          0o600,
        );
        return { owned: true as const, ...owner };
      }),
    ),
    (owner) =>
      owner.owned
        ? locked(
            Effect.gen(function* () {
              const current = yield* read;
              if (current?.nonce === owner.nonce) yield* fs.remove(file);
            }),
          ).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `Could not release dev session: ${error.message}`,
              ),
            ),
          )
        : Effect.void,
  );
});
