/**
 * Repro probe: what does the destroy driver do when a provider `delete`
 * FAILS with a typed error (retry `while` predicate rejected it)?
 * Expected: failure is collected and the destroy fails fast with a
 * DeleteFailure aggregate. Suspected (Router hang): something in the
 * failure path goes silent instead.
 */
import * as Provider from "@/Provider.ts";
import { Resource } from "@/Resource";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

interface Stubborn extends Resource<"Test.Stubborn", {}, { name: string }> {}
const Stubborn = Resource<Stubborn>("Test.Stubborn");

/** Depends on Stubborn so its delete is ordered AFTER Stubborn's. */
interface Dependent extends Resource<
  "Test.Dependent",
  { upstream: string },
  { name: string }
> {}
const Dependent = Resource<Dependent>("Test.Dependent");

class DeleteBlewUp extends Data.TaggedError("DeleteBlewUp")<{
  message: string;
}> {}

let deleteAttempts = 0;

const providers = () =>
  Layer.mergeAll(
    Provider.succeed(Stubborn, {
    reconcile: Effect.fn(function* ({ id, output }) {
      return output ?? { name: id };
    }),
    delete: Effect.fn(function* () {
      deleteAttempts++;
      yield* Effect.logInfo(`stubborn delete attempt=${deleteAttempts}`);
      return yield* Effect.fail(
        new DeleteBlewUp({ message: "unrecoverable typed error" }),
      );
    }),
    }),
    Provider.succeed(Dependent, {
    reconcile: Effect.fn(function* ({ id, news, output }) {
      return output ?? { name: id };
    }),
      delete: Effect.fn(function* () {
        yield* Effect.logInfo("dependent deleted");
      }),
    }),
  );

const { test } = Test.make({ providers: providers() });

describe("delete failure probe", () => {
  test.provider(
    "a typed delete failure fails the destroy fast (no silent hang)",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            const s = yield* Stubborn("Blocker", {});
            const d = yield* Dependent("Downstream", { upstream: s.name });
            return { s, d };
          }),
        );

        const started = Date.now();
        const exit = yield* Effect.exit(stack.destroy());
        const elapsed = Date.now() - started;

        // The destroy must FAIL (not succeed, not hang past the test budget).
        expect(Exit.isFailure(exit)).toBe(true);
        // And fail promptly — the drain loop must not spin or sleep forever.
        expect(elapsed).toBeLessThan(20_000);
        // The failing delete must not be retried unboundedly across passes.
        expect(deleteAttempts).toBeLessThanOrEqual(3);
      }),
    { timeout: 60_000, retry: 0 },
  );
});
