/**
 * Substrate-INDEPENDENT driver internals — the pieces every `Driver`
 * implementation shares regardless of where its sessions live (an
 * in-process `Map` on the resident host, Durable Objects for
 * `DriverCloudflare`). These are pure functions of a charter's terms:
 * rendering a capability's tagged template, compiling `AI.Tool`s and
 * the intrinsics into effect-AI tools, and the message shapes the
 * thread is built from.
 *
 * Kept here (not duplicated per driver) so the two implementations
 * diverge ONLY where the substrate forces them to — the loop's
 * concurrency and the session's persistence — never in how a stance
 * becomes a toolkit. See designs/ai/driver-cloudflare.md.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";
import { isAiError, type AiError } from "effect/unstable/ai/AiError";
import type * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Prompt from "effect/unstable/ai/Prompt";
import * as AiTool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import { RuntimeContext } from "../RuntimeContext.ts";
import type { Actor } from "./Actor.ts";
import { isAgent, type Agent } from "./Agent.ts";
import { isDispatchTool, type DispatchTool } from "./Dispatch.ts";
import type { Turn, TurnFn } from "./Driver.ts";
import { Refused } from "./Errors.ts";
import { isEvent } from "./Event.ts";
import type { ModelService } from "./Model.ts";
import type { EncodedCrash, SessionObservation } from "./Observer.ts";
import { isParameter } from "./Parameter.ts";
import { dedentTemplate, isFragment, type Fragment } from "./Prose.ts";
import { isSkill, type Skill, type SkillService } from "./Skill.ts";
import type { ThreadHandle } from "./ThreadStorage.ts";
import { ToolCalling, type ToolPresentation } from "./ToolCalling.ts";
import { isTool, isToolImpl, type Tool } from "./Tool.ts";

/**
 * A burst failure, described for the driver's two consumers (spec
 * §11b): `error` is the ORIGINAL value — waiters fail with it, typed
 * and catchable — and `encoded` is the serializable summary the
 * `crashed` observation carries.
 */
export interface CrashInfo {
  readonly error: unknown;
  readonly encoded: EncodedCrash;
}

/** Extract {@link CrashInfo} from a burst's failure Cause. */
export const describeCrash = (cause: Cause.Cause<unknown>): CrashInfo => {
  for (const reason of cause.reasons) {
    const error = Cause.isFailReason(reason)
      ? reason.error
      : Cause.isDieReason(reason)
        ? reason.defect
        : undefined;
    if (error === null || error === undefined) continue;
    if (isAiError(error)) {
      return {
        error,
        encoded: {
          _tag: error.reason._tag,
          message: error.message,
          retryable: error.isRetryable,
        },
      };
    }
    if (typeof error === "object") {
      const obj = error as { _tag?: unknown; message?: unknown };
      return {
        error,
        encoded: {
          _tag: typeof obj._tag === "string" ? obj._tag : undefined,
          message:
            typeof obj.message === "string" && obj.message.length > 0
              ? obj.message
              : String(error),
          retryable: true,
        },
      };
    }
    return {
      error,
      encoded: { _tag: undefined, message: String(error), retryable: true },
    };
  }
  return {
    error: cause,
    encoded: { _tag: undefined, message: String(cause), retryable: true },
  };
};

/**
 * Render an {@link EncodedCrash} (or a legacy string row) into one
 * line — a convenience for PROJECTIONS; the driver itself never calls
 * this.
 */
export const renderCrash = (error: EncodedCrash | string): string =>
  typeof error === "string"
    ? error
    : error._tag !== undefined
      ? `${error._tag}: ${error.message}`
      : error.message;

/**
 * Inbox ENVELOPE for driver-minted inputs that carry provenance (a
 * `Thread.remind` delivery). Unwrapped at drain: the thread and the
 * turn's `inputs` see only `text` — the in-band `[reminder]` marker
 * stays model-facing — while the `input` observation gets a
 * structural `kind` (spec: projections never parse text markers).
 */
export interface ReminderInput {
  readonly "~alchemy/input": "reminder";
  readonly text: string;
}

export const reminderInput = (note: string): ReminderInput => ({
  "~alchemy/input": "reminder",
  text: `[reminder] ${note}`,
});

/** Unwrap an inbox row into its thread value + observation kind. */
export const inputProvenance = (
  input: unknown,
): { readonly value: unknown; readonly kind?: "reminder" } =>
  typeof input === "object" &&
  input !== null &&
  "~alchemy/input" in input &&
  (input as ReminderInput)["~alchemy/input"] === "reminder"
    ? { value: (input as ReminderInput).text, kind: "reminder" }
    : { value: input };

/**
 * Render a capability term's own tagged template into prose (a tool's
 * description, a skill's teaching, a parameter's field description).
 * Capability terms render as their NAME (backticked, so the model sees
 * the same identifier the toolkit declares); anything else renders as
 * its string value.
 */
export const renderRef = (ref: unknown): string => {
  if (isToolImpl(ref)) {
    return `\`${ref.tool["~alchemy/Name"]}\``;
  }
  if (isTool(ref) || isParameter(ref) || isEvent(ref) || isSkill(ref)) {
    return `\`${(ref as { "~alchemy/Name": string })["~alchemy/Name"]}\``;
  }
  if (isAgent(ref)) {
    return (ref as { "~alchemy/Name": string })["~alchemy/Name"];
  }
  return String(ref);
};

export const render = (
  template: TemplateStringsArray,
  refs: ReadonlyArray<any>,
) => {
  const parts = dedentTemplate(template);
  let out = parts[0] ?? "";
  for (let index = 0; index < refs.length; index++) {
    out += renderRef(refs[index]) + (parts[index + 1] ?? "");
  }
  return out.trim();
};

/**
 * Compile one `AI.Tool` term into an effect AI tool: the template is
 * the description, the spliced `Parameter`s are the schema.
 * `failureMode: "return"` is the org's failure discipline — a
 * handler's `Effect.fail(text)` is a MODEL-VISIBLE tool result the
 * agent reacts to, never a loop crash.
 *
 * Every driver-compiled tool is annotated `Strict: false`: providers
 * that default to strict structured-output tool calling (Anthropic)
 * compile each schema through a grammar whose codec rewrites every
 * optional parameter into a required nullable union AND caps
 * union-typed parameters per request (16) — a working toolkit (the
 * Coding skill alone carries ~20 optional params) cannot fit. The
 * driver's toolkits are dynamic and open-ended, so strict grammars
 * are the wrong trade; non-strict tool calling has no such limit.
 */
export const compileTool = (term: Tool<any, any[]>) => {
  const fields: Record<string, S.Top> = {};
  for (const ref of term.refs) {
    if (!isParameter(ref)) continue;
    // the Parameter's template IS the field's description — annotate
    // the schema so it reaches the provider's JSON schema (description
    // and schema are one artifact, all the way to the wire)
    const description = render(ref.template, ref.refs);
    fields[ref["~alchemy/Name"]] =
      description.length > 0
        ? ((ref.schema as any).annotate({ description }) as S.Top)
        : ref.schema;
  }
  return AiTool.make(term["~alchemy/Name"], {
    description: render(term.template, term.refs),
    // `S.Struct({})` compiles to `anyOf: [object, array]` — no top-level
    // `type` — which Anthropic rejects. A tool without parameters omits
    // the schema entirely (an empty object schema is the default).
    ...(Object.keys(fields).length > 0
      ? { parameters: S.Struct(fields) as any }
      : {}),
    // the declared RETURN schema (`AI.Tool("readDiff", S.String)`) —
    // codemode renders it into the generated signature
    success: (term.returns as S.Top | undefined) ?? S.Unknown,
    failure: S.Unknown,
    failureMode: "return",
  }).annotate(AiTool.Strict, false);
};

/**
 * Compile the ONE delegation tool for a tick's agent mentions:
 * `${Engineer}` and `${Reviewer}` in the rendered stance grant a
 * single `dispatch` affordance whose `agent` parameter is the CLOSED
 * set of mentioned names — the model can only reach agents the tick's
 * prose hired. The task must stand alone because the delegate's session is
 * its OWN conversation (fresh key, fresh transcript); the delegate
 * never sees the host's.
 *
 * `session` is the CALL/REPLY seam (the gen_server pattern): a
 * repeated dispatch with the same session continues the SAME worker
 * session — full context, same worktree — via the driver's
 * admit-or-enqueue semantics. Sessions are namespaced under the
 * dispatching session's key, so two issues' "fix" sessions never collide.
 */
export const compileDispatch = (names: ReadonlyArray<string>) =>
  AiTool.make("dispatch", {
    description:
      `Hand one task to another agent and await their answer. ` +
      `Available agents: ${names.join(", ")}. State the task ` +
      `completely — the agent sees only what you write here, never ` +
      `this conversation. Pass a short \`session\` name to make the ` +
      `worker RESUMABLE: dispatching the same agent + session again ` +
      `continues that same worker with its full context intact (use ` +
      `it for follow-ups, fixes, and back-and-forth); omit session ` +
      `for one-off work.`,
    parameters: S.Struct({
      agent: S.Literals(names as [string, ...string[]]),
      task: S.String,
      session: S.optionalKey(S.String),
    }) as any,
    success: S.Unknown,
    failure: S.Unknown,
    failureMode: "return",
  }).annotate(AiTool.Strict, false);

/**
 * Compile the intrinsic `spawn` tool: every interpreted term may
 * conjure ANONYMOUS, task-scoped workers to perform its duties — the
 * named term stays the representative and point of contact; spawns
 * are ephemeral labor. Spawning grants nothing new: a worker's tools
 * are a SUBSET of the spawner's current tick's (enum-constrained), its
 * skills a subset of the same (handed over PRE-ACTIVATED), and workers
 * can neither spawn nor dispatch nor manage skills — no runaway
 * recursion, no laundered authority.
 */
export const compileSpawn = (
  toolNames: ReadonlyArray<string>,
  skillNames: ReadonlyArray<string>,
) =>
  AiTool.make("spawn", {
    description:
      `Spawn a fresh subagent to perform one task and await its ` +
      `answer. Write its role in \`instructions\` and state the task ` +
      `completely — it sees only what you write here, never this ` +
      `conversation.` +
      (toolNames.length > 0
        ? ` Grant it a subset of your tools via \`tools\` ` +
          `(default: all of them).`
        : "") +
      (skillNames.length > 0
        ? ` Hand it skills via \`skills\` — they arrive activated, ` +
          `instructions and tools included (default: none).`
        : ""),
    parameters: S.Struct({
      instructions: S.String,
      task: S.String,
      ...(toolNames.length > 0
        ? {
            tools: S.optionalKey(
              S.Array(S.Literals(toolNames as [string, ...string[]])),
            ),
          }
        : {}),
      ...(skillNames.length > 0
        ? {
            skills: S.optionalKey(
              S.Array(S.Literals(skillNames as [string, ...string[]])),
            ),
          }
        : {}),
    }) as any,
    success: S.Unknown,
    failure: S.Unknown,
    failureMode: "return",
  }).annotate(AiTool.Strict, false);

/**
 * Compile the intrinsic `skill` tool: a stance's skill mentions are
 * ACCESS; this tool is ACTIVATION. Activating returns the skill's
 * prose (the documentation enters the conversation exactly when it is
 * needed) and enables its tools for the rest of the session; deactivating
 * retires them — the agent manages its own working set.
 */
export const compileSkillTool = (names: ReadonlyArray<string>) =>
  AiTool.make("skill", {
    description:
      `Activate or deactivate one of your skills. Activating returns ` +
      `the skill's instructions and enables its tools for the rest of ` +
      `this conversation. Available skills: ${names.join(", ")}.`,
    parameters: S.Struct({
      action: S.Literals(["activate", "deactivate"]),
      skill: S.Literals(names as [string, ...string[]]),
    }) as any,
    success: S.Unknown,
    failure: S.Unknown,
    failureMode: "return",
  }).annotate(AiTool.Strict, false);

/** A work item or steering message, rendered as one user message. */
export const asUserMessage = (input: unknown): Prompt.MessageEncoded => ({
  role: "user",
  content: [
    {
      type: "text",
      text: typeof input === "string" ? input : JSON.stringify(input),
    },
  ],
});

/**
 * A note — the charter's EVENT channel (`AI.say`): a point-in-time
 * remark, delivered once into the current thread in the user role (the
 * only channel existing model APIs accept mid-conversation environment
 * input on), delimited so it is never mistaken for the human's words.
 */
export const noteMessage = (body: string): Prompt.MessageEncoded => ({
  role: "user",
  content: [{ type: "text", text: `<note>\n${body}\n</note>` }],
});

/**
 * Appended to every system prompt: how to read the one driver-authored
 * channel. Constant text — a static charter's system prompt stays
 * byte-stable for prompt caching.
 */
export const NOTE_CODA = `

---
As work proceeds, <note> messages may arrive — point-in-time remarks from the process hosting this work.`;

/** First occurrence wins — a shared tool appears once in a toolkit. */
export const dedupeByName = (
  tools: ReadonlyArray<AiTool.Any>,
): Array<AiTool.Any> => {
  const seen = new Set<string>();
  return tools.filter((tool) =>
    seen.has(tool.name) ? false : (seen.add(tool.name), true),
  );
};

/** One tool mention in a rendered stance — tagged or inline. */
export interface CompiledToolRef {
  readonly term: Tool<any, any[]>;
  /** Inline (closure) implementation — bypasses context resolution. */
  readonly impl?: (params: any) => Effect.Effect<any, any, any>;
}

/**
 * One tick's rendered stance: the document (as BLOCKS, the diffing
 * granularity) and the capabilities its prose mentioned.
 */
export interface Stance {
  readonly blocks: ReadonlyArray<string>;
  readonly tools: Map<string, CompiledToolRef>;
  readonly skills: Map<string, Skill<string, any>>;
  readonly delegates: Map<string, Agent<any, any>>;
  /** Policy-constrained dispatches (`AI.Dispatch`) mentioned this tick. */
  readonly doors: Map<string, DispatchTool<string, any[]>>;
}

/** `Omit` distributed over a union (plain `Omit` collapses it). */
type DistributiveOmit<T, K extends PropertyKey> = T extends any
  ? Omit<T, K>
  : never;

/** An observation as a host emits it — the envelope (term, key, seq,
 *  at) is the host's to stamp. */
export type ObservationDraft = DistributiveOmit<
  SessionObservation,
  "term" | "key" | "seq" | "at"
>;

/** What one tick hands the loop: the rendered system prompt and the
 *  assembled toolkit. */
export interface TickResult {
  readonly system: string;
  readonly toolkit: Toolkit.WithHandler<any> | undefined;
}

/** The `spawn` intrinsic's parameters. */
export interface SpawnParams {
  readonly instructions: string;
  readonly task: string;
  readonly tools?: ReadonlyArray<string>;
  readonly skills?: ReadonlyArray<string>;
}

/** A skill implementation, resolved from the charter's context. */
export interface ResolvedSkill {
  readonly prose: string;
  readonly tools: ReadonlyArray<AiTool.Any>;
  readonly handlers: Record<
    string,
    (params: any) => Effect.Effect<any, any, any>
  >;
  /** Skills the teaching references — exposed on activation. */
  readonly skills: ReadonlyArray<Skill<string, any>>;
}

/** The thread crosses storage in its ENCODED form — rows are JSON. */
export const encodeMessages = S.encodeSync(S.Array(Prompt.Message));

/**
 * WHAT A HOST LENDS THE ALGORITHM about one session — the adapter
 * both hosts implement. The resident host (DriverCore) backs it with
 * an in-process SessionState; the Durable Object host backs it with
 * its own storage rows. Everything else — turn evaluation, stance
 * rendering, the skill graph, toolkit assembly, sampling — is the
 * shared functions below, written once.
 */
export interface SessionOps {
  /** The driver's name, for error/log prefixes. */
  readonly driver: string;
  readonly term: string;
  readonly key: string;
  /** The charter's captured Layer context: capability resolution and
   *  the optional seams (`ToolCalling`). */
  readonly context: Context.Context<never>;
  /** Provide the session-scoped services (`AI.Thread`, `AI.Tick`,
   *  refs, the captured context, the runtime color) to charter code. */
  readonly provide: <A, E>(
    effect: Effect.Effect<A, E, any>,
  ) => Effect.Effect<A, E>;
  /** The session's TURN, produced by its charter init. */
  readonly turn: () => Turn | TurnFn;
  /** Samplings performed so far. */
  readonly tick: () => number;
  /** Reset the say buffer — each turn ATTEMPT starts clean. */
  readonly clearNotes: () => void;
  /** A durable observation (persisted, cursor advances). */
  readonly observe: (observation: ObservationDraft) => Effect.Effect<void>;
  /** A live observation (broadcast only — deltas, in-flight calls). */
  readonly observeLive: (observation: ObservationDraft) => Effect.Effect<void>;
  /** Activated skills; activation is persisted by the host. */
  readonly activeSkills: () => ReadonlySet<string>;
  readonly setSkill: (name: string, active: boolean) => Effect.Effect<void>;
  /** The last rendered stance — what `spawn`/`skill` grant from. */
  readonly lastStance: () => Stance | undefined;
  readonly setLastStance: (stance: Stance) => void;
  /** Remember a dispatched child for the supervision cascade. */
  readonly registerChild: (
    agent: string,
    childKey: string,
    actor: Actor,
  ) => void;
  /** The spawn intrinsic — host-specific (the resident host runs an
   *  anonymous worker session; a host may refuse). */
  readonly spawn: (params: SpawnParams) => Effect.Effect<unknown>;
  /** Optional sealing applied to every toolkit handler (the DO host
   *  provides the runtime capability once here). */
  readonly wrapHandler?: (
    handler: (params: any) => Effect.Effect<any, any, any>,
  ) => (params: any) => Effect.Effect<any, any>;
}

/**
 * Capability resolution from the charter's captured context, memoized
 * per interpret — the term is the name; the SERVICE is the physics.
 */
export const makeResolvers = (
  driver: string,
  term: string,
  context: Context.Context<never>,
) => {
  const handlerCache = new Map<
    string,
    (params: any) => Effect.Effect<any, any, any>
  >();
  const resolveHandler = (compiled: CompiledToolRef) =>
    Effect.gen(function* () {
      const name = compiled.term["~alchemy/Name"];
      if (compiled.impl !== undefined) return compiled.impl;
      const cached = handlerCache.get(name);
      if (cached !== undefined) return cached;
      const service = Context.getOption(context, compiled.term as any);
      if (Option.isNone(service)) {
        return yield* Effect.die(
          `${driver}: no implementation provided for tool '${name}' of '${term}' — provide the tool's Layer or splice an inline impl`,
        );
      }
      // the tool contract: the service IS the callable (a Layer
      // needing runtime setup unwraps inside its own build)
      const resolved = service.value as (
        params: any,
      ) => Effect.Effect<any, any, any>;
      handlerCache.set(name, resolved);
      return resolved;
    });

  const skillCache = new Map<string, ResolvedSkill>();
  const resolveSkill = (skill: Skill<string, any>) =>
    Effect.gen(function* () {
      const skillName = skill["~alchemy/Name"];
      const cached = skillCache.get(skillName);
      if (cached !== undefined) return cached;
      const service = Context.getOption(context, skill as any);
      if (Option.isNone(service)) {
        return yield* Effect.die(
          `${driver}: no implementation provided for skill '${skillName}' referenced by '${term}'`,
        );
      }
      // the IMPLEMENTATION carries the teaching: prose, spliced
      // tools, and their physics all come from the resolved
      // service — the term is only the name
      const impl = service.value as SkillService;
      const skillTools = impl.refs.filter(isTool);
      const handlers: ResolvedSkill["handlers"] = {};
      for (const tool of skillTools) {
        const name = tool["~alchemy/Name"];
        const resolved = impl.tools[name];
        if (resolved === undefined) {
          return yield* Effect.die(
            `${driver}: skill '${skillName}' implementation provides no tool '${name}'`,
          );
        }
        handlers[name] = resolved;
      }
      const entry: ResolvedSkill = {
        prose: render(impl.template, impl.refs),
        tools: skillTools.map(compileTool),
        handlers,
        // a teaching may reference DEEPER skills: activating this
        // one exposes them for activation — the skill GRAPH
        skills: impl.refs.filter(isSkill),
      };
      skillCache.set(skillName, entry);
      return entry;
    });

  const delegateCache = new Map<string, Actor>();
  const resolveDelegate = (agent: Agent<any, any>) =>
    Effect.gen(function* () {
      const name = agent["~alchemy/Name"];
      const cached = delegateCache.get(name);
      if (cached !== undefined) return cached;
      const service = Context.getOption(context, agent as any);
      if (Option.isNone(service)) {
        return yield* Effect.die(
          `${driver}: no implementation provided for agent '${name}' referenced by '${term}'`,
        );
      }
      const actor = service.value as Actor;
      delegateCache.set(name, actor);
      return actor;
    });

  return { resolveHandler, resolveSkill, resolveDelegate };
};

export type Resolvers = ReturnType<typeof makeResolvers>;

/**
 * Render a stance's fragment tree into blocks + mentions. Effect
 * splices evaluate through `ops.provide` at render time, EVERY tick.
 */
export const renderStance = (
  ops: SessionOps,
  root: Fragment,
): Effect.Effect<Stance> =>
  Effect.gen(function* () {
    const blocks: Array<string> = [];
    const tools = new Map<string, CompiledToolRef>();
    const skills = new Map<string, Skill<string, any>>();
    const delegates = new Map<string, Agent<any, any>>();
    const doors = new Map<string, DispatchTool<string, any[]>>();
    let buffer = "";
    const flush = () => {
      const text = buffer.trim();
      if (text.length > 0) blocks.push(text);
      buffer = "";
    };
    const walk = (fragment: Fragment): Effect.Effect<void> =>
      Effect.gen(function* () {
        const parts = dedentTemplate(fragment.template);
        buffer += parts[0] ?? "";
        for (let index = 0; index < fragment.refs.length; index++) {
          const ref = fragment.refs[index];
          // term guards FIRST: tags are themselves yieldable
          // (Effect.isEffect is true for every Service class)
          if (isDispatchTool(ref)) {
            // a DOOR: policy-constrained dispatch — renders as
            // its tool name; the driver builds its handler
            doors.set(ref["~alchemy/Name"], ref);
            buffer += `\`${ref["~alchemy/Name"]}\``;
          } else if (isToolImpl(ref)) {
            const name = ref.tool["~alchemy/Name"];
            tools.set(name, { term: ref.tool, impl: ref.impl });
            buffer += `\`${name}\``;
          } else if (isTool(ref)) {
            const name = ref["~alchemy/Name"];
            if (!tools.has(name)) tools.set(name, { term: ref });
            buffer += `\`${name}\``;
          } else if (isSkill(ref)) {
            skills.set(ref["~alchemy/Name"], ref);
            buffer += `\`${ref["~alchemy/Name"]}\``;
          } else if (isAgent(ref)) {
            delegates.set(ref["~alchemy/Name"], ref as Agent<any, any>);
            buffer += ref["~alchemy/Name"];
          } else if (isEvent(ref) || isParameter(ref)) {
            buffer += `\`${ref["~alchemy/Name"]}\``;
          } else if (isFragment(ref)) {
            flush();
            yield* walk(ref);
            flush();
          } else if (Effect.isEffect(ref)) {
            // evaluated at render time, EVERY tick — a nested
            // AI.prose, a component's turn value
            const value = yield* ops.provide(ref as Effect.Effect<unknown>);
            if (isFragment(value)) {
              flush();
              yield* walk(value);
              flush();
            } else if (isToolImpl(value)) {
              // an inline tool spliced without its init yield*
              // still grants — same as the direct splice
              const name = value.tool["~alchemy/Name"];
              tools.set(name, { term: value.tool, impl: value.impl });
              buffer += `\`${name}\``;
            } else if (isDispatchTool(value)) {
              doors.set(value["~alchemy/Name"], value);
              buffer += `\`${value["~alchemy/Name"]}\``;
            } else {
              buffer += String(value);
            }
          } else {
            buffer += String(ref);
          }
          buffer += parts[index + 1] ?? "";
        }
      });
    yield* walk(root);
    flush();
    return { blocks, tools, skills, delegates, doors };
  });

/**
 * One TICK, written once for every host: evaluate the session's turn
 * (function turns receive `{count, inputs}`), render the stance,
 * walk the skill graph to its active fixpoint, and assemble this
 * sampling's system prompt + toolkit — capabilities through the
 * optional `ToolCalling` seam, intrinsics always direct.
 */
export const compileTick = (
  ops: SessionOps,
  resolvers: Resolvers,
  inputs: ReadonlyArray<unknown>,
): Effect.Effect<TickResult> =>
  Effect.gen(function* () {
    const result = yield* ops.provide(
      Effect.suspend(() => {
        // each ATTEMPT starts with a clean say buffer, so a
        // retried turn delivers only the successful
        // evaluation's notes — never a failed attempt's
        ops.clearNotes();
        const turn = ops.turn();
        return typeof turn === "function"
          ? turn({ count: ops.tick(), inputs })
          : turn;
      }).pipe(
        // transient turn failures (an observation fetch, a
        // flaky service) retry; a typed Refused is the session
        // GIVING UP and propagates immediately
        Effect.retry({
          while: (error) => !(error instanceof Refused),
          schedule: Schedule.exponential("1 second"),
          times: 3,
        }),
      ) as Effect.Effect<unknown>,
    );
    if (Effect.isEffect(result)) {
      return yield* Effect.die(
        `${ops.driver}: the turn of '${ops.term}' (session '${ops.key}') returned an Effect — did you forget to yield* an AI.prose?`,
      );
    }
    if (!isFragment(result)) {
      return yield* Effect.die(
        `${ops.driver}: the turn of '${ops.term}' (session '${ops.key}') returned a non-Fragment value — turns return the stance; answer callers with AI.reply`,
      );
    }
    const stance = yield* renderStance(ops, result);

    // the SKILL GRAPH: a stance mention is access at the root;
    // an ACTIVE skill's teaching exposes the skills it
    // references (access, one level per activation) — walk the
    // active frontier to a fixpoint so nested doctrine trees
    // resolve however deep the activations go
    const active = ops.activeSkills();
    const effectiveSkills = new Map(stance.skills);
    {
      const frontier = [...active];
      const visited = new Set<string>();
      while (frontier.length > 0) {
        const name = frontier.pop()!;
        if (visited.has(name)) continue;
        visited.add(name);
        const term = effectiveSkills.get(name);
        if (term === undefined) continue; // not reachable now
        const resolved = yield* resolvers.resolveSkill(term);
        for (const sub of resolved.skills) {
          const subName = sub["~alchemy/Name"];
          if (!effectiveSkills.has(subName)) {
            effectiveSkills.set(subName, sub);
          }
          if (active.has(subName)) frontier.push(subName);
        }
      }
    }
    ops.setLastStance({ ...stance, skills: effectiveSkills });

    /**
     * Wrap a tool handler so its FAILURES are observable in the
     * process log: a failing tool result is model-visible (the
     * agent reacts), but without this the operator sees nothing —
     * a session burning its budget against a broken tool looks
     * like silence from the outside.
     */
    const observedHandler =
      (name: string, fn: (params: any) => Effect.Effect<any, any, any>) =>
      (input: any) =>
        ops
          .provide(fn(input))
          .pipe(
            Effect.tapError((error) =>
              Effect.logWarning(
                `Driver session '${ops.key}' of '${ops.term}': tool '${name}' failed: ${String(error).slice(0, 500)}`,
              ),
            ),
          );

    // this tick's CAPABILITIES: mentioned tools + active∩reachable
    // skills' tools, with their handlers
    const capabilityHandlers: Record<
      string,
      (params: any) => Effect.Effect<any, any>
    > = {};
    const charterTools: Array<AiTool.Any> = [];
    for (const [name, compiled] of stance.tools) {
      charterTools.push(compileTool(compiled.term));
      const resolved = yield* resolvers.resolveHandler(compiled);
      capabilityHandlers[name] = observedHandler(name, resolved);
    }
    const activeTools: Array<AiTool.Any> = [];
    for (const name of active) {
      const skillTerm = effectiveSkills.get(name);
      if (skillTerm === undefined) continue; // not reachable now
      const resolved = yield* resolvers.resolveSkill(skillTerm);
      activeTools.push(...resolved.tools);
      for (const [toolName, fn] of Object.entries(resolved.handlers)) {
        capabilityHandlers[toolName] ??= observedHandler(toolName, fn);
      }
    }

    // DOORS: policy-constrained dispatches (`AI.Dispatch`) —
    // presented as the org's own tools, EXECUTED by the driver:
    // the policy derives {task, key}, the child registers for
    // the supervision cascade, the parentage edge is stamped,
    // and the observation carries the delegation identity.
    // Deliberately NOT in stance.tools: spawn must never hand a
    // door to a worker (workers are leaves).
    const doorTools: Array<AiTool.Any> = [];
    for (const [name, door] of stance.doors) {
      doorTools.push(compileTool(door as never));
      const doorHandler = (params: any) =>
        Effect.gen(function* () {
          const derived = yield* door.policy(params, { key: ops.key });
          const actor = yield* resolvers.resolveDelegate(door.agent);
          const agentName = door.agent["~alchemy/Name"];
          if (derived.key !== undefined) {
            ops.registerChild(agentName, derived.key, actor);
          }
          yield* ops.observe({
            type: "dispatched",
            tick: ops.tick(),
            toolName: name,
            agent: agentName,
            child: derived.key,
          });
          return yield* actor
            .dispatch(derived.task, {
              key: derived.key,
              parent: { term: ops.term, key: ops.key },
            })
            .pipe(Effect.provide(RuntimeContext.phantom));
        });
      capabilityHandlers[name] = observedHandler(name, doorHandler);
    }

    // the TOOL-CALLING seam: an optional convention transforms how
    // the capabilities are PRESENTED (e.g. codemode collapses them
    // into one `eval` tool) — mention-is-presence unchanged;
    // absent, every grant is its own provider tool
    const capabilityTools = dedupeByName([
      ...charterTools,
      ...activeTools,
      ...doorTools,
    ]);
    const toolCalling = Context.getOption(ops.context, ToolCalling);
    const wire: ToolPresentation =
      Option.isSome(toolCalling) && capabilityTools.length > 0
        ? yield* toolCalling.value.present(
            capabilityTools.map((tool) => ({
              name: tool.name,
              description: AiTool.getDescription(tool) ?? "",
              parameters: AiTool.getJsonSchema(tool),
              returns: AiTool.getJsonSchemaFromSchema(
                (tool as any).successSchema,
              ),
              handler: capabilityHandlers[tool.name]!,
            })),
          )
        : { tools: capabilityTools, handlers: capabilityHandlers };

    // intrinsics stay DIRECT tools in every convention — they are
    // conversation control, not capabilities
    const handlers: Record<string, (params: any) => Effect.Effect<any, any>> = {
      ...wire.handlers,
    };
    const delegates = new Map<string, Actor>();
    for (const [name, agent] of stance.delegates) {
      delegates.set(name, yield* resolvers.resolveDelegate(agent));
    }
    if (delegates.size > 0) {
      // stamp the DELEGATION EDGE: the child session's `admitted`
      // observation records who dispatched it, so observers can
      // reconstruct the tree (issue desk → engineer → …). A
      // `session` name derives a DETERMINISTIC child key namespaced
      // under this session — the call/reply seam: same name,
      // same worker, same context — and the child is REMEMBERED
      // for the supervision cascade (settle propagates down).
      handlers.dispatch = (params: {
        agent: string;
        task: string;
        session?: string;
      }) =>
        Effect.gen(function* () {
          const actor = delegates.get(params.agent)!;
          const key =
            params.session === undefined
              ? undefined
              : `${ops.key}/${params.agent}/${params.session}`;
          if (key !== undefined) {
            ops.registerChild(params.agent, key, actor);
          }
          yield* ops.observe({
            type: "dispatched",
            tick: ops.tick(),
            toolName: "dispatch",
            agent: params.agent,
            child: key,
          });
          return yield* actor
            .dispatch(params.task, {
              key,
              parent: { term: ops.term, key: ops.key },
            })
            .pipe(Effect.provide(RuntimeContext.phantom));
        });
    }
    handlers.spawn = (params) => ops.spawn(params as SpawnParams);
    /** The per-session `skill` switch — activation is the session's
     *  act, persisted by the host. */
    handlers.skill = (params: {
      action: "activate" | "deactivate";
      skill: string;
    }) =>
      Effect.gen(function* () {
        if (params.action === "deactivate") {
          yield* ops.setSkill(params.skill, false);
          return `deactivated ${params.skill}`;
        }
        const skillTerm = ops.lastStance()?.skills.get(params.skill);
        if (skillTerm === undefined) {
          // model-visible: the stance no longer mentions it
          return `no skill named '${params.skill}' is available right now`;
        }
        const resolved = yield* resolvers.resolveSkill(skillTerm);
        yield* ops.setSkill(params.skill, true);
        return resolved.prose;
      });

    const intrinsics: Array<AiTool.Any> = [
      ...(delegates.size > 0 ? [compileDispatch([...delegates.keys()])] : []),
      compileSpawn([...stance.tools.keys()], [...effectiveSkills.keys()]),
      ...(effectiveSkills.size > 0
        ? [compileSkillTool([...effectiveSkills.keys()])]
        : []),
    ];
    const toolkit = yield* buildToolkit(
      dedupeByName([...wire.tools, ...intrinsics]),
      handlers,
      ops.wrapHandler === undefined
        ? undefined
        : { wrapHandler: ops.wrapHandler },
    );

    // the render IS the system prompt, verbatim — no diffing,
    // no derived messages. A static charter is byte-stable
    // (prompt cache); a changed render simply changes the
    // system prompt, on the author's head. Everything dynamic
    // reaches the thread explicitly: says, tool results, steers.
    return {
      system: stance.blocks.join("\n\n") + NOTE_CODA,
      toolkit,
    };
  });

/**
 * ONE SAMPLING, written once for every host: read the thread from
 * the handle, call the `Model`, surface live parts as observations,
 * and either append the response (with its durable `assistant` and
 * `tool-result` observations) or — on a malformed tool call within
 * budget — append the corrective note and report `malformed` so the
 * host comes straight back around.
 */
export const sampleTick = (options: {
  readonly ops: SessionOps;
  readonly model: ModelService;
  readonly handle: ThreadHandle;
  readonly tick: TickResult;
  /** True once the host's malformed streak exceeds the budget — the
   *  validation error then propagates as the round's real failure. */
  readonly exhausted: boolean;
}): Effect.Effect<
  | { readonly kind: "malformed" }
  | {
      readonly kind: "response";
      readonly response: LanguageModel.GenerateTextResponse<any>;
    },
  unknown
> =>
  Effect.gen(function* () {
    const { ops, model, handle, tick } = options;
    // persistence must never crash or slow a round — a failed
    // append costs restart fidelity, not the sampling
    const append = (
      messages: ReadonlyArray<Prompt.MessageEncoded>,
    ): Effect.Effect<void> =>
      handle
        .appendMessages(messages)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `ThreadStorage append failed for '${ops.key}' of '${ops.term}'`,
              cause,
            ),
          ),
        );
    const startedAt = yield* Effect.sync(() => Date.now());
    const thread = Prompt.make([...(yield* handle.messages)]);
    const response = yield* model
      .step({
        prompt: Prompt.concat(
          Prompt.make([{ role: "system", content: tick.system }]),
          thread,
        ),
        toolkit: tick.toolkit,
        onLive: (part) =>
          part.kind === "tool-call"
            ? ops.observeLive({
                type: "tool-call",
                tick: ops.tick(),
                toolCallId: part.id,
                toolName: part.name,
                input: part.params,
              })
            : ops.observeLive({
                type: "assistant-delta",
                tick: ops.tick(),
                channel: part.kind,
                delta: part.delta,
              }),
      })
      .pipe(
        // A MALFORMED TOOL CALL is a model-visible fact, not a
        // crash: nothing was executed, so tell the model what
        // was wrong and let it re-issue. Bounded — a model that
        // keeps emitting invalid calls crashes with the real
        // error after the Model's streak budget.
        Effect.catchIf(
          (error): error is AiError =>
            isAiError(error) &&
            error.reason._tag === "ToolParameterValidationError",
          (error) =>
            options.exhausted
              ? Effect.fail(error)
              : Effect.succeed({ malformed: error.message } as const),
        ),
      );
    if ("malformed" in response) {
      const text =
        `your last response included a tool call with INVALID ` +
        `parameters — NOTHING was executed:\n${response.malformed}\n` +
        `Re-issue the call with parameters matching the tool's schema.`;
      yield* append([noteMessage(text)]);
      yield* ops.observe({
        type: "input",
        text: `<note>\n${text}\n</note>`,
        kind: "note",
      });
      return { kind: "malformed" } as const;
    }
    // durable response rows FIRST, then the observations that
    // restate them — a crash between the two loses commentary,
    // never the thread
    yield* append(
      encodeMessages(Prompt.fromResponseParts(response.content).content),
    );
    // where the time goes: one line per sampling (model
    // round-trip INCLUDING the tool handlers that ran
    // inside it) — the timing profile of every session
    yield* Effect.logInfo(
      `Driver session '${ops.key}' of '${ops.term}': sampling #${ops.tick()} took ${Date.now() - startedAt}ms` +
        (response.toolCalls.length > 0
          ? ` [${response.toolCalls.map((call) => call.name).join(", ")}]`
          : " [quiesced]"),
    );
    yield* ops.observe({
      type: "assistant",
      tick: ops.tick(),
      ms: Date.now() - startedAt,
      text: response.text,
      reasoning: response.reasoningText,
      toolCalls: response.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        input: call.params,
      })),
    });
    // tool OUTPUTS are not restated by `assistant` — they are
    // their own durable rows, upgrading the call's state in
    // any projection that replays this session
    for (const result of response.toolResults) {
      yield* ops.observe({
        type: "tool-result",
        toolCallId: result.id,
        toolName: result.name,
        output: result.result,
        isFailure: result.isFailure,
      });
    }
    return { kind: "response", response } as const;
  });

/**
 * Assemble a toolkit from compiled tools + this tick's handlers —
 * shared by both drivers. `toHandlers` dies on keys that name no tool
 * in the kit, so exactly the kit's handlers are passed. `wrapHandler`
 * lets a driver seal every handler once (the DO driver provides the
 * runtime capability here — handlers run inside its event — rather
 * than at every construction site).
 */
export const buildToolkit = (
  tools: ReadonlyArray<AiTool.Any>,
  handlers: Record<string, (params: any) => Effect.Effect<any, any, any>>,
  options?: {
    readonly wrapHandler?: (
      handler: (params: any) => Effect.Effect<any, any, any>,
    ) => (params: any) => Effect.Effect<any, any>;
  },
): Effect.Effect<Toolkit.WithHandler<any> | undefined> =>
  tools.length === 0
    ? Effect.succeed(undefined)
    : (Effect.gen(function* () {
        const kit = Toolkit.make(...tools) as Toolkit.Toolkit<any>;
        const subset: Record<string, unknown> = {};
        for (const tool of tools) {
          const handler = handlers[tool.name];
          if (handler === undefined) continue;
          subset[tool.name] =
            options?.wrapHandler === undefined
              ? handler
              : options.wrapHandler(handler);
        }
        const handlerContext = yield* kit.toHandlers(subset as any);
        return (yield* Effect.provide(
          kit as Effect.Effect<Toolkit.WithHandler<any>, never, any>,
          handlerContext,
        )) as Toolkit.WithHandler<any>;
      }) as Effect.Effect<Toolkit.WithHandler<any> | undefined>);
