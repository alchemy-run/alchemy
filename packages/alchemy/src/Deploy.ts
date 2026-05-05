import * as Effect from "effect/Effect";
import { AlchemyContext } from "./AlchemyContext.ts";
import * as Apply from "./Apply.ts";
import type { Input } from "./Input.ts";
import * as Plan from "./Plan.ts";
import { evalStack, type CompiledStack, type StackEffect } from "./Stack.ts";
import { Stage } from "./Stage.ts";

export const deploy = <A>({
  stack,
  stage,
  dev,
}: {
  stack: StackEffect<CompiledStack<A>, Stage | AlchemyContext>;
  stage: string;
  dev?: boolean;
}) =>
  evalStack(
    stack,
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* Plan.make(stack);
        const output = yield* Apply.apply(plan);
        return output as Input.Resolve<A>;
      }),
    { stage, dev },
  );
