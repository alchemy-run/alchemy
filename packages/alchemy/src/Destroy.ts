import { Effect } from "effect";
import type * as Scope from "effect/Scope";
import * as Apply from "./Apply.ts";
import * as Plan from "./Plan.ts";
import type { StackDefinition } from "./Stack.ts";
import { evalStack, withoutProgram } from "./Stack.ts";

export const destroy = <ROut>({
  stack,
  stage,
  dev,
  scope,
  include,
  exclude,
}: {
  /** The stack to tear down; its program is never run. */
  stack: StackDefinition<ROut>;
  stage: string;
  dev?: boolean;
  /** See {@link evalStack} — when set, scoped resources outlive `destroy`. */
  scope?: Scope.Scope;
  /** Destroy always operates on the full stack. */
  include?: never;
  exclude?: never;
}) =>
  include !== undefined || exclude !== undefined
    ? Effect.die(
        new Plan.InvalidResourceSelection({ message: "Filtered destroy is not supported." }),
      )
    : evalStack(
        withoutProgram(stack),
        (stack) => Plan.destroy(stack).pipe(Effect.flatMap(Apply.apply)),
        {
          stage,
          dev,
          scope,
        },
      );
