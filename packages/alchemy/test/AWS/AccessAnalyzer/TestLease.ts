import { withLock } from "@/Auth/Lock.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

// AWS permits only one ACCOUNT_UNUSED_ACCESS analyzer per account and Region.
// Run the suite inside the same Effect-native, cross-process lock used by auth.
// The manually-owned scope bridges the test runner's separate beforeAll and
// afterAll effects; closing it interrupts the holder and runs the lock finalizer.
export const makeAccessAnalyzerTestLease = () => {
  let scope: Scope.Closeable | undefined;

  return {
    acquire: Effect.gen(function* () {
      const acquired = yield* Deferred.make<void, unknown>();
      scope = yield* Scope.make();
      yield* withLock(
        "test-access-analyzer-unused-access",
        Deferred.succeed(acquired, undefined).pipe(
          Effect.andThen(Effect.never),
        ),
        // Suites hold the lock across their whole beforeAll → afterAll.
        { timeout: "10 minutes" },
      ).pipe(
        Effect.onError((cause) => Deferred.failCause(acquired, cause)),
        Effect.forkIn(scope),
      );
      yield* Deferred.await(acquired);
    }),
    release: Effect.suspend(() => {
      if (scope === undefined) return Effect.void;
      const current = scope;
      scope = undefined;
      return Scope.close(current, Exit.void);
    }),
  };
};
