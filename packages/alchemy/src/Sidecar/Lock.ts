import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as RpcPaths from "./RpcPaths.ts";

export class LockError extends Schema.TaggedErrorClass<LockError>()(
  "LockError",
  {
    reason: Schema.Literals([
      "Cancelled",
      "Conflict",
      "Invalid",
      "Timeout",
      "PlatformError",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.DefectWithStack),
  },
) {}

export class Lock extends Context.Service<
  Lock,
  {
    readonly check: Effect.Effect<boolean>;
    readonly acquire: Effect.Effect<
      Fiber.Fiber<number, LockError>,
      LockError,
      Scope.Scope
    >;
  }
>()("Lock") {}

const LOCK_TTL = Duration.seconds(10);
const TOUCH_INTERVAL = Duration.seconds(1);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* RpcPaths.RpcPaths;

  const readLockFile = fs.readFileString(paths.lock).pipe(
    Effect.mapError(
      (e) =>
        new LockError({
          reason: "PlatformError",
          message:
            e.reason._tag === "NotFound"
              ? "Lock file not found"
              : "Failed to read lock file",
          cause: e,
        }),
    ),
    Effect.flatMap((text) => {
      const pid = Number.parseInt(text);
      return Number.isNaN(pid)
        ? Effect.fail(
            new LockError({
              reason: "Invalid",
              message: "Lock file is invalid",
            }),
          )
        : Effect.succeed(pid);
    }),
  );

  const isLockProcessAlive = readLockFile.pipe(
    Effect.flatMap((pid) =>
      Effect.sync(() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }),
    ),
    Effect.orElseSucceed(() => false),
  );

  const isLockFileStale = fs.stat(paths.lock).pipe(
    Effect.map((stat) => {
      const mtime = Option.getOrElse(stat.mtime, () => new Date(0));
      return mtime.getTime() < Date.now() - Duration.toMillis(LOCK_TTL);
    }),
    Effect.orElseSucceed(() => true),
  );

  const isLockValid = Effect.zipWith(
    isLockProcessAlive,
    isLockFileStale,
    (alive, stale) => alive && !stale,
    {
      concurrent: true,
    },
  );

  const makeLockFile = fs
    .writeFileString(paths.lock, process.pid.toString(), { flag: "wx" })
    .pipe(
      Effect.mapError((e) =>
        e.reason._tag === "AlreadyExists"
          ? new LockError({
              reason: "Conflict",
              message: "Lock already held by another process",
            })
          : new LockError({
              reason: "PlatformError",
              message: "Failed to create lock file",
              cause: e,
            }),
      ),
    );

  const assertOwnLock = readLockFile.pipe(
    Effect.flatMap((pid) =>
      pid === process.pid
        ? Effect.void
        : Effect.fail(
            new LockError({
              reason: "Conflict",
              message: "Lock not held by this process",
            }),
          ),
    ),
  );

  const removeLock = fs.remove(paths.lock, { force: true }).pipe(
    Effect.mapError(
      (e) =>
        new LockError({
          reason: "PlatformError",
          message: "Failed to remove lock file",
          cause: e,
        }),
    ),
  );

  const releaseLock = assertOwnLock.pipe(Effect.andThen(() => removeLock));

  const acquireLock = makeLockFile.pipe(
    Effect.catchIf(
      (e) => e.reason === "Conflict",
      (e) =>
        isLockValid.pipe(
          Effect.flatMap((valid) =>
            valid
              ? Effect.fail(e)
              : removeLock.pipe(Effect.andThen(() => makeLockFile)),
          ),
        ),
    ),
  );

  const touchLock = assertOwnLock.pipe(
    Effect.flatMap(() => {
      const now = Date.now();
      return fs.utimes(paths.lock, now, now).pipe(
        Effect.mapError(
          (e) =>
            new LockError({
              reason: "PlatformError",
              message: "Failed to update lock file",
              cause: e,
            }),
        ),
      );
    }),
  );

  return Lock.of({
    check: isLockValid,
    acquire: acquireLock.pipe(
      Effect.flatMap(() =>
        touchLock.pipe(
          Effect.repeat(Schedule.spaced(TOUCH_INTERVAL)),
          Effect.ensuring(releaseLock.pipe(Effect.ignore)),
          Effect.forkScoped,
        ),
      ),
    ),
  });
});

export const LockLive = Layer.effect(Lock, make);
