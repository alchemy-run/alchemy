import * as lockfile from "@alchemy.run/node-utils";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as RpcPaths from "./RpcPaths.ts";

export class LockError extends Schema.TaggedErrorClass<LockError>()(
  "LockError",
  {
    reason: Schema.Literals(["Conflict", "PlatformError"]),
    message: Schema.String,
    cause: Schema.optional(Schema.DefectWithStack),
  },
) {}

export class Lock extends Context.Service<
  Lock,
  {
    readonly check: Effect.Effect<boolean>;
    readonly acquire: Effect.Effect<
      Fiber.Fiber<never, LockError>,
      LockError,
      Scope.Scope
    >;
  }
>()("Lock") {}

const STALE_MS = 10_000;
const UPDATE_MS = 1_000;

const make = Effect.gen(function* () {
  const paths = yield* RpcPaths.RpcPaths;

  const check = Effect.tryPromise(() =>
    lockfile.check(paths.lock, { stale: STALE_MS, realpath: false }),
  ).pipe(Effect.orElseSucceed(() => false));

  const acquire = Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          lockfile.lock(paths.lock, {
            stale: STALE_MS,
            update: UPDATE_MS,
            retries: 0,
            realpath: false,
          }),
        catch: (cause) =>
          new LockError({
            reason: "Conflict",
            message: "Lock already held by another process",
            cause,
          }),
      }),
      (release) => Effect.promise(() => release().catch(() => {})),
    );
    return yield* Effect.never;
  }).pipe(Effect.forkScoped);

  return Lock.of({ check, acquire });
});

export const LockLive = Layer.effect(Lock, make);
