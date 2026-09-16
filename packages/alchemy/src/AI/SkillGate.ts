import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * The SKILL GATE — the org's runtime switch over skill activation.
 *
 * A charter GRANTS skills statically (mention-is-presence); the gate
 * decides, per agent, whether a granted skill may currently be
 * ACTIVATED. The driver consults it at the two activation doors — the
 * `skill` intrinsic and a spawn's pre-activated skill handoff. No gate
 * provided means allow-all; a gated refusal is model-visible (the
 * agent is told the skill is switched off), never a crash.
 *
 * The implementation is the host's business (services/root keeps the
 * per-agent config in its database and PATCHes it from the org UI).
 */
export class SkillGate extends Context.Service<
  SkillGate,
  {
    /** May `agent` activate `skill` right now? */
    readonly enabled: (agent: string, skill: string) => Effect.Effect<boolean>;
  }
>()("alchemy/AI/SkillGate") {}
