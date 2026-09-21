import type { ConfigError } from "effect/Config";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { AlchemyContext } from "./AlchemyContext.ts";
import * as Apply from "./Apply.ts";
import type { Input } from "./Input.ts";
import * as Plan from "./Plan.ts";
import { evalStack, type CompiledStack, type StackEffect } from "./Stack.ts";
import { Stage } from "./Stage.ts";

export interface DeployOptions<A> extends Plan.MakePlanOptions {
  stack: StackEffect<CompiledStack<A>, ConfigError, Stage | AlchemyContext>;
  stage: string;
  dev?: boolean;
  /** See {@link evalStack} — when set, scoped resources outlive `deploy`. */
  scope?: Scope.Scope;
}

export type DeployResult<A> = Effect.Effect<
  Input.Resolve<A>,
  Effect.Error<ReturnType<typeof deployStack<A>>>,
  Effect.Services<ReturnType<typeof deployStack<A>>>
>;

type DeploymentOutput<
  A,
  Options extends Plan.MakePlanOptions,
> = "targets" extends keyof Options
  ? Options["targets"] extends ReadonlyArray<string>
    ? undefined
    : Options["targets"] extends undefined
      ? A
      : A | undefined
  : A;

/**
 * Reconcile a stack. Targets select nodes and their transitive dependencies,
 * not declaration evaluation: the whole stack program still runs. Targeted
 * deployments return void and leave persisted full-stack outputs unchanged.
 */
export function deploy<
  A,
  Options extends DeployOptions<A> = DeployOptions<A> & { targets?: undefined },
>(
  options: DeployOptions<A> & Options,
): DeployResult<DeploymentOutput<A, Options>>;
export function deploy<A>(options: DeployOptions<A>) {
  return deployStack(options);
}

const deployStack = <A>({
  stack,
  stage,
  dev,
  scope,
  force,
  targets,
}: DeployOptions<A>) =>
  evalStack(
    stack,
    (stack) =>
      Effect.gen(function* () {
        const plan = yield* Plan.make(stack, { force, targets });
        const output = yield* Apply.apply(plan);
        return output;
      }),
    { stage, dev, scope },
  );
