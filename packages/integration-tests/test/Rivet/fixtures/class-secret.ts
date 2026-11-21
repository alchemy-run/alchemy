/**
 * A secret a Durable Object class reads as config. A pool must hand it to
 * its nodes without writing it where its host's config is readable: the
 * class dies at runtime unless it reads the value the deploy saw, so the
 * suites that use it fail if the secret never reaches the node.
 */
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export const CLASS_SECRET_NAME = "RIVET_TEST_CLASS_SECRET";
export const CLASS_SECRET = "class-secret-sentinel";

/** The deploy's value for the secret, under whatever the profile provides. */
export const ClassSecretConfig = ConfigProvider.layerAdd(
  ConfigProvider.fromUnknown({ [CLASS_SECRET_NAME]: CLASS_SECRET }),
);

/** A class phase that reads the secret first, and dies if it is not the deploy's. */
export const withClassSecret = <A, E, R>(phase: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const secret = yield* Config.Redacted(CLASS_SECRET_NAME).pipe(Effect.orDie);
    if (Redacted.value(secret) !== CLASS_SECRET) {
      return yield* Effect.die(`${CLASS_SECRET_NAME} did not reach the node`);
    }
    return yield* phase;
  });
