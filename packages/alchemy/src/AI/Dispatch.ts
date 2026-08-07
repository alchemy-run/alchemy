import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { Agent } from "./Agent.ts";
import type { Services } from "./Services.ts";
import type { ToolParameters } from "./Tool.ts";

/** The requirement a door contributes: the delegate agent's tag. */
type AgentService<A> = A extends Context.Service<infer Id, any> ? Id : never;

/** What a door's policy derives from the model's parameters. */
export interface DispatchDerived {
  /** The task handed to the worker — it sees nothing else. */
  readonly task: string;
  /**
   * The child run key (`${thread.key}/Engineer/build`): a REPEAT
   * dispatch to the same key continues the same worker, context
   * intact. Omitted = a fresh anonymous run per call.
   */
  readonly key?: string;
}

/**
 * A DOOR: a policy-constrained dispatch presented as the org's own
 * tool. The framework keeps the MECHANISM (the driver executes the
 * call — parentage stamped, child registered for the supervision
 * cascade, the observation carries its delegation identity); userland
 * keeps the PRESENTATION and POLICY (the tool's name, its prose, its
 * parameter schema, and the code deriving `{task, key}` — session
 * policy is enforced by ABSENCE: no session parameter exists at the
 * wire for the model to misuse).
 *
 * ```ts
 * export const HandToEngineer = AI.Dispatch(Engineer, "hand_to_engineer")`
 *   Hand one round of issue work to the engineer — ${task} stands
 *   alone: issue reference and acceptance criteria verbatim.`(
 *   (p, thread) => ({ task: p.task, key: `${thread.key}/Engineer/build` }),
 * );
 * // in a charter's init:  const handToEngineer = yield* HandToEngineer;
 * // in its prose:         …a ready issue goes through ${handToEngineer}…
 * ```
 *
 * The policy may be an `Effect` returning the function, so a door
 * defined at module scope can pull its own dependencies — their tags
 * ride the yielded Effect's requirement channel into the charter's
 * Layer graph:
 *
 * ```ts
 * export const HandToEngineer = AI.Dispatch(Engineer, "hand_to_engineer")`
 *   …${task}…`(
 *   Effect.gen(function* () {
 *     const ledger = yield* Ledger;
 *     return Effect.fn(function* (p, thread) {
 *       yield* ledger.put(`handoff:${thread.key}`, Date.now());
 *       return { task: p.task, key: `${thread.key}/Engineer/build` };
 *     });
 *   }),
 * );
 * ```
 *
 * A policy failure (`Effect.fail`) is a MODEL-VISIBLE tool result —
 * "that handoff is not allowed right now" — never a loop crash. A
 * bare `${Agent}` mention remains the generic, free-session dispatch
 * for supervisors trusted with composition; doors are for invariants.
 */
export interface DispatchTool<
  Name extends string = string,
  Refs extends any[] = any[],
> {
  readonly "~alchemy/Kind": "DispatchTool";
  readonly "~alchemy/Name": Name;
  readonly agent: Agent<any, any>;
  readonly template: TemplateStringsArray;
  readonly refs: Refs;
  /** Normalized policy: params + thread facts → derived, effectfully. */
  readonly policy: (
    params: ToolParameters<Refs[number]>,
    thread: { readonly key: string },
  ) => Effect.Effect<DispatchDerived, any, any>;
}

type Policy<Refs extends any[]> = (
  params: ToolParameters<Refs[number]>,
  thread: { readonly key: string },
) => DispatchDerived | Effect.Effect<DispatchDerived, any, any>;

export const Dispatch: {
  <A extends Agent<any, any>, const Name extends string>(
    agent: A,
    name: Name,
  ): <const Refs extends any[]>(
    template: TemplateStringsArray,
    ...refs: Refs
  ) => {
    <R = never>(
      policy: Effect.Effect<Policy<Refs>, any, R>,
    ): Effect.Effect<
      DispatchTool<Name, Refs>,
      never,
      Services<Refs> | AgentService<A> | R
    >;
    (
      policy: Policy<Refs>,
    ): Effect.Effect<
      DispatchTool<Name, Refs>,
      never,
      Services<Refs> | AgentService<A>
    >;
  };
} = ((agent: Agent<any, any>, name: string) =>
  (template: TemplateStringsArray, ...refs: any[]) =>
  (policy: any) =>
    Effect.gen(function* () {
      const fn = Effect.isEffect(policy) ? yield* policy : policy;
      return {
        "~alchemy/Kind": "DispatchTool",
        "~alchemy/Name": name,
        agent,
        template,
        refs,
        policy: (params: any, thread: any) => {
          const out = fn(params, thread);
          return Effect.isEffect(out) ? out : Effect.succeed(out);
        },
      } satisfies DispatchTool<any, any>;
    })) as never;

export const isDispatchTool = (
  value: unknown,
): value is DispatchTool<string, any[]> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "DispatchTool";
