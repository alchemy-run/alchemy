import { Effect } from "effect";
import type { AlchemyContext } from "./AlchemyContext.ts";
import * as Apply from "./Apply.ts";
import * as Plan from "./Plan.ts";
import type { CompiledStack, StackEffect } from "./Stack.ts";
import { evalStack } from "./Stack.ts";
import type { Stage } from "./Stage.ts";

export const destroy = ({
  stack,
  stage,
  dev,
}: {
  stack: StackEffect<CompiledStack, Stage | AlchemyContext>;
  stage: string;
  dev?: boolean;
}) =>
  evalStack(
    stack,
    (stack) =>
      Plan.make({
        ...stack,
        // zero these out (destroy will treat all as orphans)
        // TODO(sam): probably better to have Plan.destroy and Plan.update
        resources: {},
        bindings: {},
        output: {},
      }).pipe(Effect.flatMap(Apply.apply)),
    { stage, dev },
  );
