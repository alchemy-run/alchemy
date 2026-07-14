import type { ConfigError } from "effect/Config";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { AlchemyContext } from "./AlchemyContext.ts";
import * as Apply from "./Apply.ts";
import type { Input } from "./Input.ts";
import * as Plan from "./Plan.ts";
import { evalStack, type CompiledStack, type StackEffect } from "./Stack.ts";
import { Stage } from "./Stage.ts";
import * as Tail from "./Tail.ts";

export const deploy = <A>({
  stack,
  stage,
  dev,
  scope,
  force,
  tail,
}: {
  stack: StackEffect<CompiledStack<A>, ConfigError, Stage | AlchemyContext>;
  stage: string;
  dev?: boolean;
  /** See {@link evalStack} — when set, scoped resources outlive `deploy`. */
  scope?: Scope.Scope;
  force?: boolean;
  /**
   * After a successful apply, fork a background fiber streaming every
   * tailable resource's logs to the console. The fiber is scoped: it lives
   * until the surrounding scope closes (with the test harness's shared
   * scope, that's `destroy(...)` / the file's `afterAll`). Used by
   * `Test.make({ log: true })`.
   */
  tail?: boolean;
}) =>
  evalStack(
    stack,
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* Plan.make(stack, { force });
        const output = yield* Apply.apply(plan);
        if (tail) {
          // Tail failures must never fail (or interrupt) the deploy —
          // they're diagnostics, not part of the deployment contract.
          yield* Tail.tailStack(stack).pipe(
            Effect.catchCause((cause) =>
              Effect.logDebug("stack tail failed", cause),
            ),
            Effect.forkScoped,
          );
        }
        return output as Input.Resolve<A>;
      }),
    { stage, dev, scope },
  );
