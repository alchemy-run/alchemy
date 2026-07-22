import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type { Actor } from "./Actor.ts";
import type { Agent } from "./Agent.ts";
import type { KernelError } from "./Errors.ts";
import type { Accepts } from "./Event.ts";
import type { Process } from "./Process.ts";
import type { Services } from "./Services.ts";
import { isSkill, type Skill, type SkillService } from "./Skill.ts";
import { isTool } from "./Tool.ts";

/**
 * The two term kinds the Kernel can interpret. Capability terms
 * (`Tool`/`Parameter`) are compiled *into* their host's turns — they
 * have no runs and no loop of their own.
 */
export type Interpretable =
  | Agent<any, any, any[], any>
  | Process<any, any, any, any[], any>;

/**
 * The Kernel is the interpreter of {@link Agent} and {@link Process}
 * terms — one method.
 *
 * `interpret` turns a term (pure data: prose + refs) into the live
 * {@link Actor} verbs, resolving the term's ref tags from the
 * ambient context (which is why the term's `Req` rides the
 * requirement channel). Interpretation is **scoped**: it acquires the
 * term's single serial loop, whose lifetime is the Scope's.
 *
 * For an Agent the verbs ARE the tag's public service ({@link layer}
 * packages that). For a Process the verbs are PRIVATE: only its
 * implementation Layer calls `interpret`, wires the world to the
 * verbs, and exposes the declared Shape.
 *
 * Note the vocabulary that is absent: memory, compaction, context,
 * sandbox, session-store, sub-agent, model, event bus, trace. Those
 * are COMPONENT Layers a particular kernel *implementation* requires
 * by name — invisible to this contract.
 */
export interface KernelService {
  readonly interpret: <T extends Interpretable>(
    term: T,
  ) => Effect.Effect<Actor, KernelError, T["~alchemy/Req"] | Scope.Scope>;
}

export class Kernel extends Context.Service<Kernel, KernelService>()(
  "alchemy/AI/Kernel",
) {}

/**
 * Interpret a term's charter into its live LOOP — the
 * {@link Actor} verbs — resolving `AI.Kernel` from context. An
 * uninterpretable charter dies (a deployment defect, not a runtime
 * error the caller could react to).
 *
 * This deliberately returns the verbs for BOTH term kinds — a Shape
 * cannot come out of a kernel, because only a Process's hand-written
 * Layer knows how to build it. For an Agent the verbs ARE the tag's
 * service, and {@link layer} packages this call. For a Process the
 * verbs are the PRIVATE loop its implementation Layer drives and then
 * hides behind the declared Shape:
 *
 * ```ts
 * export const IssuesLive = Layer.effect(Issues, Effect.gen(function* () {
 *   const issues = yield* AI.interpret(Issues);      // the loop, private
 *   yield* GitHub.consumeRepositoryEvents(repo, …);  // the world drives it
 *   return { list: … };                              // the Shape, public
 * }));
 * ```
 */
export const interpret = <T extends Interpretable>(
  term: T,
): Effect.Effect<
  Actor<Accepts<T["refs"]>>,
  never,
  Kernel | T["~alchemy/Req"] | Scope.Scope
> =>
  Effect.orDie(
    Effect.flatMap(Kernel, (kernel) => kernel.interpret(term)),
  ) as never;

/**
 * The kernel-default implementation Layer for an AGENT term: the
 * term's tag out, the term's refs' tags plus `Kernel` in. Transitive
 * elimination is Layer composition — each agent gets its own
 * capability provisioning via `Layer.provide`.
 *
 * Agent-only, by design: an agent's tag IS the verbs `interpret`
 * returns, so the kernel can implement it mechanically. A Process's
 * tag is its declared Shape — only its hand-written Layer knows how
 * to build that, so there is nothing for a default to do.
 */
export const layer: {
  /**
   * The default SKILL Layer: the skill's tag out, its TOOLS' tags in —
   * the bundle is nominal (charters require `Coding`, never `Grep`)
   * and providing this Layer is what surfaces the tool requirements.
   * A custom `Layer.effect(Coding, …)` may instead build the whole
   * bundle's physics inline.
   */
  <L extends Skill<any, any[], any> & Context.Service<any, any>>(
    term: L,
  ): Layer.Layer<L["Identifier"], never, Services<L["refs"]>>;
  <L extends Agent<any, any, any[], any> & Context.Service<any, any>>(
    term: L,
  ): Layer.Layer<L["Identifier"], never, Kernel | L["~alchemy/Req"]>;
} = ((term: any) =>
  isSkill(term)
    ? Layer.effect(
        term as any,
        Effect.gen(function* () {
          const context = yield* Effect.context<never>();
          const tools: SkillService["tools"] = {};
          for (const ref of term.refs) {
            if (!isTool(ref)) continue;
            const name = (ref as { "~alchemy/Name": string })["~alchemy/Name"];
            const service = Context.getOption(context, ref as any);
            if (Option.isNone(service)) {
              return yield* Effect.die(
                `AI.layer: no implementation provided for tool '${name}' of skill '${term["~alchemy/Name"]}'`,
              );
            }
            tools[name] = Effect.isEffect(service.value)
              ? yield* service.value as Effect.Effect<any>
              : service.value;
          }
          return { tools } satisfies SkillService;
        }) as any,
      )
    : Layer.effect(term, interpret(term) as any)) as any;
