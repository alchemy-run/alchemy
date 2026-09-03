import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { isAiError, type AiError } from "effect/unstable/ai/AiError";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Prompt from "effect/unstable/ai/Prompt";
import * as AiTool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import * as PersistentRef from "../PersistentRef.ts";
import { RuntimeContext } from "../RuntimeContext.ts";
import type { Actor } from "./Agent.ts";
import { isAgent, type Agent } from "./Agent.ts";
import { isDispatchTool, type DispatchTool } from "./Dispatch.ts";
import type { Charter, Turn, TurnFn } from "./Driver.ts";
import { Refused } from "./Errors.ts";
import { isEvent } from "./Event.ts";
import * as Response from "effect/unstable/ai/Response";
import {
  isLiveObservation,
  RoundAbandoned,
  Events,
  type EncodedCrash,
  type SessionObservation,
} from "./Events.ts";
import { isParameter } from "./Parameter.ts";
import { dedentTemplate, isFragment, type Fragment } from "./Fragment.ts";
import type {
  SessionSocketHost,
  SessionSocketServerFrame,
} from "./SessionSocket.ts";
import {
  isSkill,
  type Skill,
  type SkillService,
  type Teaching,
} from "./Skill.ts";
import {
  Thread,
  Tick,
  type CompactPlan,
  type ThreadService,
  type TickService,
} from "./Thread.ts";
import type {
  SessionMeta,
  ThreadHandle,
  ThreadStorageService,
} from "./ThreadStorage.ts";
import {
  errorTag,
  isErrorTerm,
  isTool,
  isToolImpl,
  type Tool,
} from "./Tool.ts";
import { Tools, type ToolPresentation } from "./Tools.ts";

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

/** The outcome an operator's `Sessions.stop`/`remove` settles with. */
export const stoppedByOperator = { _tag: "Stopped", by: "operator" } as const;

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

/**
 * Render a template with its splices to prose — or anything that
 * CARRIES one: a {@link Teaching} (a `Skill.make`…`` Layer), a
 * {@link Fragment}, a term with a static template. The one text a
 * skill's agents activate is thereby the text a document prints:
 *
 * ```ts
 * const HarnessGeneral = Harness.make`…`;
 * const markdown = AI.render(HarnessGeneral);
 * ```
 */
export const render: {
  (template: TemplateStringsArray, refs: ReadonlyArray<any>): string;
  (teaching: Teaching): string;
} = (
  templateOrTeaching: TemplateStringsArray | Teaching,
  refs?: ReadonlyArray<any>,
) => {
  const [template, splices] =
    refs === undefined
      ? [
          (templateOrTeaching as Teaching).template,
          (templateOrTeaching as Teaching).refs,
        ]
      : [templateOrTeaching as TemplateStringsArray, refs];
  const parts = dedentTemplate(template);
  let out = parts[0] ?? "";
  for (let index = 0; index < splices.length; index++) {
    out += renderRef(splices[index]) + (parts[index + 1] ?? "");
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
/**
 * The DECLARED FAILURES a compiled tool carries, read back off the
 * tool by the tool engine — see {@link ToolGrant.errors}. An
 * annotation (rather than a field) because the compiled artifact is
 * effect-AI's `Tool`, whose shape we do not own.
 */
export const ToolErrorTags: Context.Reference<
  ReadonlyArray<{ readonly tag: string; readonly fields?: unknown }>
> = Context.Reference("alchemy/AI/ToolErrorTags", {
  defaultValue: (): ReadonlyArray<{
    readonly tag: string;
    readonly fields?: unknown;
  }> => [],
});

/** The declared failures of a compiled tool, oldest mention first. */
export const getToolErrors = (
  tool: AiTool.Any,
): ReadonlyArray<{ readonly tag: string; readonly fields?: unknown }> =>
  Context.get(tool.annotations, ToolErrorTags);

export const compileTool = (term: Tool<any, any[]>) => {
  const fields: Record<string, S.Top> = {};
  // ERROR mention-is-presence: the error classes the template splices
  // ARE the tool's failure channel; everything else is a defect
  const errors: Array<{ tag: string; fields?: unknown }> = [];
  const errorSchemas: Array<S.Top> = [];
  for (const ref of term.refs) {
    if (isErrorTerm(ref)) {
      const tag = errorTag(ref);
      if (errors.some((error) => error.tag === tag)) continue;
      // a Schema.TaggedError is itself a schema — it can describe its
      // fields on the wire; a Data.TaggedError contributes its tag
      const schema = S.isSchema(ref as never)
        ? (ref as unknown as S.Top)
        : undefined;
      if (schema !== undefined) errorSchemas.push(schema);
      errors.push({
        tag,
        ...(schema !== undefined
          ? { fields: AiTool.getJsonSchemaFromSchema(schema as never) }
          : {}),
      });
      continue;
    }
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
    // the declared failures, when they can describe themselves;
    // `failureMode: "return"` keeps a failure a MODEL-VISIBLE result
    failure:
      errorSchemas.length === 0
        ? S.Unknown
        : errorSchemas.length === 1
          ? errorSchemas[0]!
          : (S.Union(errorSchemas as never) as S.Top),
    failureMode: "return",
  })
    .annotate(AiTool.Strict, false)
    .annotate(ToolErrorTags, errors);
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

/**
 * FNV-1a 64-bit over UTF-16 code units, as hex — CHANGE DETECTION for
 * the request envelope (`stance` observation), not security. Pure and
 * platform-neutral: DriverCore runs on Node, bun, and workerd alike,
 * so no `node:crypto`, no async `crypto.subtle`.
 */
const fnv1a64 = (text: string): string => {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
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
   *  the optional seams (`Tools`). */
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
  /**
   * The DIRECT wire's session-lifetime tool union, in first-mention
   * order — the payload stays byte-stable across phase flips
   * (KV-cache prefix), while mention-is-presence is enforced by
   * handler: a union tool the CURRENT tick's stance does not mention
   * rejects model-visibly. In-memory: a restart resets the union to
   * the tick's own mentions (the provider cache is cold then anyway).
   */
  readonly wireUnion: () => Map<string, AiTool.Any>;
  /** The last logged request envelope's hash — the `stance`
   *  observation snapshots the full envelope only when it changes. */
  readonly lastEnvelopeHash: () => string | undefined;
  readonly setLastEnvelopeHash: (hash: string) => void;
  /** Remember a dispatched child for the supervision cascade. */
  readonly registerChild: (
    agent: string,
    childKey: string,
    actor: Actor,
  ) => void;
  /** The spawn intrinsic — the engine drives an anonymous worker
   *  session inline; its failure is a model-visible tool result. */
  readonly spawn: (params: SpawnParams) => Effect.Effect<unknown, unknown>;
  /** Optional sealing applied to every toolkit handler (the DO host
   *  provides the runtime capability once here). */
  readonly wrapHandler?: (
    handler: (params: any) => Effect.Effect<any, any, any>,
  ) => (params: any) => Effect.Effect<any, any>;
}

/**
 * Apply one requested compaction to a session's thread — shared by
 * every host because it operates purely on the {@link ThreadHandle}.
 * The system prompt is untouched; drops leave an archived marker
 * (restorable eviction — nothing is silently rewritten); reset
 * restarts the thread from one summary note.
 */
export const applyCompactionPlan = (
  handle: ThreadHandle,
  plan: CompactPlan,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if ("reset" in plan) {
      yield* handle.replaceMessages([
        noteMessage(
          `The thread was compacted; it restarts from this summary of prior work:\n${plan.reset.summary}`,
        ),
      ]);
      return;
    }
    const rows = yield* handle.messages;
    const decoded = Prompt.make([...rows]).content;
    const kept: Array<Prompt.MessageEncoded> = [];
    let dropped = 0;
    for (let index = 0; index < decoded.length; index++) {
      if (plan.drop(decoded[index]!, index)) {
        dropped++;
      } else {
        kept.push(rows[index]!);
      }
    }
    if (dropped === 0) return;
    yield* handle.replaceMessages([
      asUserMessage(
        `[${dropped} earlier message${dropped === 1 ? "" : "s"} archived by compaction]`,
      ),
      ...kept,
    ]);
  });

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
            // AI.fragment, a component's turn value
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
 * optional `Tools` seam, intrinsics always direct.
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
        `${ops.driver}: the turn of '${ops.term}' (session '${ops.key}') returned an Effect — did you forget to yield* an AI.fragment?`,
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

    // the TOOL ENGINE: an optional convention transforms how
    // the capabilities are PRESENTED (e.g. codemode collapses them
    // into one `eval` tool) — mention-is-presence unchanged;
    // absent, every mention is its own provider tool
    const capabilityTools = dedupeByName([
      ...charterTools,
      ...activeTools,
      ...doorTools,
    ]);
    const toolCalling = Context.getOption(ops.context, Tools);
    let wire: ToolPresentation;
    if (Option.isSome(toolCalling) && capabilityTools.length > 0) {
      wire = yield* toolCalling.value.present(
        capabilityTools.map((tool) => ({
          name: tool.name,
          description: AiTool.getDescription(tool) ?? "",
          parameters: AiTool.getJsonSchema(tool),
          returns: AiTool.getJsonSchemaFromSchema((tool as any).successSchema),
          errors: getToolErrors(tool),
          tool,
          handler: capabilityHandlers[tool.name]!,
        })),
      );
    } else {
      // DIRECT presentation carries the session's UNION of every tool
      // mentioned so far, in first-mention order — the provider payload
      // stays byte-stable across phase flips (KV-cache prefix), and a
      // union tool the CURRENT stance does not mention rejects
      // model-visibly, so the stance remains the sole grant authority.
      const union = ops.wireUnion();
      for (const tool of capabilityTools) union.set(tool.name, tool);
      const handlers = { ...capabilityHandlers };
      for (const name of union.keys()) {
        if (handlers[name] === undefined) {
          handlers[name] = () =>
            Effect.fail(
              `'${name}' is not available in this phase — your current ` +
                `instructions name the tools that exist right now`,
            );
        }
      }
      wire = { tools: [...union.values()], handlers };
    }

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
    const presented = dedupeByName([...wire.tools, ...intrinsics]);
    const toolkit = yield* buildToolkit(
      presented,
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
    const system = stance.blocks.join("\n\n") + NOTE_CODA;

    // MODEL-VISIBLE MEANS LOGGED: the request envelope — the rendered
    // system prompt and the presented toolkit — is a durable `stance`
    // observation, so every sampling is reconstructable from storage
    // alone. The hash is logged every tick; the full snapshot only
    // when it CHANGED (the envelope is byte-stable across most ticks).
    const envelopeTools = presented.map((tool) => ({
      name: tool.name,
      description: AiTool.getDescription(tool) ?? "",
      parameters: AiTool.getJsonSchema(tool),
    }));
    const envelopeHash = fnv1a64(
      JSON.stringify({ system, tools: envelopeTools }),
    );
    yield* ops.observe({
      type: "stance",
      tick: ops.tick(),
      hash: envelopeHash,
      ...(envelopeHash === ops.lastEnvelopeHash()
        ? {}
        : { prose: system, tools: envelopeTools }),
    });
    ops.setLastEnvelopeHash(envelopeHash);

    return {
      system,
      toolkit,
    };
  });

/** The provider surface one sampling needs from `LanguageModel`. */
export interface StreamingLanguageModel {
  readonly streamText: unknown;
}

/** A live wire fact, surfaced AS IT STREAMS (deltas, tool calls). */
type LivePart =
  | { readonly kind: "text" | "reasoning"; readonly delta: string }
  | {
      readonly kind: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly params: unknown;
    };

/**
 * One call to the {@link StreamingLanguageModel}: stream the provider
 * wire and consolidate the parts back into the response shape the
 * round consumes.
 *
 * - The wire is STREAMED so an observer sees text/thinking tokens as
 *   they arrive; block metadata is merged across deltas (Anthropic's
 *   thinking SIGNATURE arrives as a late empty delta and must survive
 *   onto the consolidated reasoning part, or the next request fails).
 * - Tool RESULTS are load-bearing: they are what
 *   `Prompt.fromResponseParts` turns into the tool message answering
 *   the call. Drop one and the thread records a call nothing ever
 *   answered — providers reject that.
 * - Retryability is the error's own testimony (spec §11b): a
 *   deterministic failure (billing, auth, content policy) must not be
 *   re-sampled — it propagates TYPED to the round. Custom retry,
 *   tiering, or budget policy belongs on the `LanguageModel` service
 *   itself: wrap it with a Layer; the loop consumes the standard
 *   effect/ai component and adds only this transient-failure default.
 */
const sampleModel = (
  languageModel: StreamingLanguageModel,
  options: {
    readonly prompt: Prompt.Prompt;
    readonly toolkit: Toolkit.WithHandler<any> | undefined;
    readonly onLive: (part: LivePart) => Effect.Effect<void>;
  },
): Effect.Effect<LanguageModel.GenerateTextResponse<any>, unknown> =>
  Effect.gen(function* () {
    const parts: Array<unknown> = [];
    // open blocks by stream id (providers interleave by index)
    const open = new Map<
      string,
      { type: "text" | "reasoning"; text: string; metadata: any }
    >();
    yield* Stream.runForEach(
      (
        languageModel.streamText as (
          streamOptions: unknown,
        ) => Stream.Stream<any, unknown>
      )({ prompt: options.prompt, toolkit: options.toolkit }),
      (part: any) =>
        Effect.gen(function* () {
          switch (part.type) {
            case "text-start":
            case "reasoning-start": {
              open.set(part.id, {
                type: part.type === "text-start" ? "text" : "reasoning",
                text: "",
                metadata: { ...part.metadata },
              });
              return;
            }
            case "text-delta":
            case "reasoning-delta": {
              const kind = part.type === "text-delta" ? "text" : "reasoning";
              const block = open.get(part.id) ?? {
                type: kind as "text" | "reasoning",
                text: "",
                metadata: {},
              };
              open.set(part.id, block);
              block.text += part.delta;
              Object.assign(block.metadata, part.metadata);
              if (part.delta.length > 0) {
                yield* options.onLive({ kind, delta: part.delta });
              }
              return;
            }
            case "text-end":
            case "reasoning-end": {
              const block = open.get(part.id);
              if (block === undefined) return;
              open.delete(part.id);
              Object.assign(block.metadata, part.metadata);
              parts.push(
                Response.makePart(block.type, {
                  text: block.text,
                  metadata: block.metadata,
                } as never),
              );
              return;
            }
            case "tool-call": {
              parts.push(part);
              // surface the call NOW — its handler may run for
              // minutes before the sampling completes
              yield* options.onLive({
                kind: "tool-call",
                id: part.id,
                name: part.name,
                params: part.params,
              });
              return;
            }
            case "tool-result":
            case "finish": {
              parts.push(part);
              return;
            }
            default:
              return;
          }
        }),
    );
    // a provider that never closed a block still yields its text
    for (const block of open.values()) {
      parts.push(
        Response.makePart(block.type, {
          text: block.text,
          metadata: block.metadata,
        } as never),
      );
    }
    return new LanguageModel.GenerateTextResponse<any>(parts as never);
  }).pipe(
    Effect.retry({
      while: (error) =>
        isAiError(error)
          ? error.isRetryable &&
            error.reason._tag !== "ToolParameterValidationError"
          : true,
      schedule: Schedule.exponential("1 second"),
      times: 3,
    }),
  );

/**
 * ONE SAMPLING, written once for every host: read the thread from
 * the handle, call the language model, surface live parts as
 * observations, and either append the response (with its durable
 * `assistant` and `tool-result` observations) or — on a malformed
 * tool call within budget — append the corrective note and report
 * `malformed` so the host comes straight back around.
 */
export const sampleTick = (options: {
  readonly ops: SessionOps;
  readonly languageModel: StreamingLanguageModel;
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
    const { ops, languageModel, handle, tick } = options;
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
    const response = yield* sampleModel(languageModel, {
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
    }).pipe(
      // A MALFORMED TOOL CALL is a model-visible fact, not a
      // crash: nothing was executed, so tell the model what
      // was wrong and let it re-issue. Bounded — a model that
      // keeps emitting invalid calls crashes with the real
      // error after the malformed budget.
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
    yield* Effect.logDebug(
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

/** What a Driver lends the engine — see {@link makeSessionEngine}. */
export interface SessionEngineOptions {
  /** The placement's name, for error/log prefixes. */
  readonly driver: string;
  readonly term: string;
  readonly charter: Charter;
  /** The charter's captured Layer context. */
  readonly context: Context.Context<never>;
  readonly storage: ThreadStorageService;
  /**
   * The standard effect/ai `LanguageModel` the loop samples with —
   * consumed directly, no wrapper concept: retry schedules, model
   * tiering, and token budgets are expressed by WRAPPING the
   * `LanguageModel` service itself with a Layer.
   */
  readonly languageModel: StreamingLanguageModel;
  /**
   * Consecutive malformed-tool-call feedback rounds (the loop tells
   * the model what was invalid and re-samples) before the validation
   * error propagates as the round's real failure. @default 3
   */
  readonly malformedBudget?: number;
  /**
   * Trigger execution of a session's pending work. The resident
   * placement wakes the session's parked fiber; the DO placement
   * `waitUntil`s a burst. Must be safe to call at any time — bursts
   * are internally serialized per session.
   */
  readonly kick: (key: string) => Effect.Effect<void>;
  /** Fan one socket frame out to the session's attached live views
   *  (RAM writer set locally; hibernatable sockets on DOs). */
  readonly broadcast: (
    key: string,
    frame: SessionSocketServerFrame,
  ) => Effect.Effect<void>;
  /** Schedule a reminder — it fires back through `send` as an
   *  ordinary input (sleeping fiber locally; alarm row on DOs). */
  readonly remind: (
    key: string,
    fireAtMillis: number,
    note: string,
  ) => Effect.Effect<void>;
  /** Schedule a recovery re-entry of `burst(key)` after a delay
   *  (forked sleep locally; the DO alarm on Cloudflare). */
  readonly scheduleReentry: (
    key: string,
    delayMillis: number,
  ) => Effect.Effect<void>;
  /** The per-session PersistentRef store (DO storage on Cloudflare).
   *  Default: an ambient store from context, else per-session memory. */
  readonly stateStore?: (key: string) => PersistentRef.StoreService;
  /** Extra sealing for toolkit handlers (the DO placement provides
   *  the runtime capability once here). */
  readonly wrapHandler?: SessionOps["wrapHandler"];
  /** Re-entries on the same round before it is abandoned with an
   *  interruption note. @default 5 */
  readonly maxAttempts?: number;
  /** Base delay before recovery re-enters a silent round (doubles
   *  per attempt, capped at 8×). @default 30 seconds */
  readonly recoverAfterMillis?: number;
}

/** One session's RAM shell — everything process-shaped. All durable
 *  facts live behind the handle. */
interface EngineSession {
  readonly key: string;
  readonly handle: ThreadHandle;
  /** Bursts are serialized per session. */
  readonly gate: Semaphore.Semaphore;
  tick: number;
  observed: number;
  readonly active: Set<string>;
  busy?: { readonly attempts: number; readonly since: number };
  settledOutcome?: { readonly outcome: unknown };
  /** The park race for a resident fiber; late verbs read
   *  `settledOutcome`. Replaced by `resume` (a Deferred is one-shot,
   *  so a reopened session needs a fresh signal to park on). */
  settledSignal: Deferred.Deferred<unknown>;
  turn?: Turn | TurnFn;
  /** Spawn workers sample a CONSTANT tick — no charter, no turn. */
  fixedTick?: TickResult;
  pendingCompaction?: CompactPlan;
  readonly pendingNotes: Array<Fragment>;
  lastStance?: Stance;
  /** Every tool the direct wire has carried, first-mention order. */
  readonly wireUnion: Map<string, AiTool.Any>;
  /** Hash of the last logged request envelope (`stance` observation). */
  envelopeHash?: string;
  /** Waiters not yet answerable, paired to their input's inbox seq —
   *  a waiter joins a round only when its own input is drained. */
  readonly pendingWaiters: Array<{
    readonly seq: number;
    readonly waiter: Deferred.Deferred<unknown, unknown>;
  }>;
  /** The current round's waiters — resolved by `AI.reply` or, for
   *  rounds that never reply, by quiescence with the response text. */
  readonly roundWaiters: Array<Deferred.Deferred<unknown, unknown>>;
  /** Session workers dispatched by this session (supervision edge). */
  readonly children: Map<
    string,
    { readonly key: string; readonly actor: Actor }
  >;
  readonly stateStore: PersistentRef.StoreService;
}

export interface SessionEngine {
  /** Fire-and-forget delivery; admits on first sight of the key. */
  readonly send: (
    input: unknown,
    options?: {
      readonly key?: string;
      readonly parent?: { readonly term: string; readonly key: string };
      readonly wake?: boolean;
    },
  ) => Effect.Effect<void>;
  /** Deliver and await the round's answer (`AI.reply` or quiescence). */
  readonly dispatch: (
    input: unknown,
    options?: {
      readonly key?: string;
      readonly parent?: { readonly term: string; readonly key: string };
    },
  ) => Effect.Effect<unknown, unknown>;
  /** Input at the sampling boundary. Unkeyed steers go to the last
   *  admitted session; a KEYED steer to an unknown key admits fresh
   *  (crash recovery — re-polled events are never dropped). */
  readonly steer: (
    key: string | undefined,
    input: unknown,
  ) => Effect.Effect<void>;
  /** End a session idempotently from the outside. `admit: true`
   *  settles even a never-seen key (the DO placement's semantics —
   *  the instance exists by virtue of being addressed). */
  readonly settle: (
    key: string,
    outcome: unknown,
    options?: { readonly admit?: boolean },
  ) => Effect.Effect<void>;
  /** REOPEN a settled session — the operator's undo for `stop`. The
   *  settled tombstone is cleared (RAM + persisted meta) and a fresh
   *  settled signal minted; the next input opens a round exactly as
   *  on a parked session. Resolves `true` when a tombstone was
   *  actually cleared — a live or never-seen key is a no-op `false`
   *  (the latter admits, mirroring `settle`'s `admit` semantics).
   *  Children settled by the cascade stay settled — resume them
   *  explicitly. */
  readonly resume: (key: string) => Effect.Effect<boolean>;
  /** ADMIT a key durably WITHOUT building its shell or running the
   *  charter's init: the `admitted` observation (and meta) land, so
   *  the session lists for every client. A known key (RAM-resident or
   *  persisted) is a no-op. The first input builds the shell over the
   *  persisted meta exactly as a restore does — no second `admitted`.
   *  Resolves `true` when a row was actually written. */
  readonly admit: (key: string) => Effect.Effect<boolean>;
  /** Settle every RAM-resident session (process shutdown). */
  readonly interrupt: Effect.Effect<void>;
  /** Drop one session's RAM entry (after `settle`) so the key can be
   *  admitted FRESH — the eraser's second half. Purging the durable
   *  rows is the driver's job (`ThreadStorage.remove` locally, the
   *  DO's `deleteAll` on Cloudflare). */
  readonly forget: (key: string) => Effect.Effect<void>;
  /** Run rounds for one session until it parks or settles —
   *  serialized per session; safe to call redundantly. */
  readonly burst: (key: string) => Effect.Effect<void>;
  /** Revive persisted sessions (parked). Returns the revived keys so
   *  a resident placement can start their fibers. */
  readonly restore: Effect.Effect<ReadonlyArray<string>>;
  /** Create-or-get a session WITHOUT feeding it (socket attach). */
  readonly ensure: (key?: string) => Effect.Effect<string>;
  /** The socket protocol surface for one session. */
  readonly socketHost: (key: string) => Effect.Effect<SessionSocketHost>;
  /** Resolves with the outcome when the session settles — the other
   *  arm of a resident fiber's park race. */
  readonly awaitSettled: (key: string) => Effect.Effect<unknown>;
}

/**
 * THE SESSION ENGINE — one implementation of a term's sessions:
 * lifecycle (admit, init-once, rounds, waiters, settle, crash,
 * restore) over the storage seam, written once for every Driver. A
 * Driver (DriverLocal's resident fibers, DriverCloudflare's Durable
 * Objects) supplies only what is physically its own: how execution is
 * kicked, how socket frames fan out, how reminders and recovery
 * re-entries are scheduled. The engine never knows where it is
 * running.
 */
export const makeSessionEngine = (
  options: SessionEngineOptions,
): SessionEngine => {
  const {
    driver,
    term,
    charter,
    context,
    storage,
    languageModel,
    kick,
    broadcast,
    scheduleReentry,
  } = options;
  const maxAttempts = options.maxAttempts ?? 5;
  const recoverAfter = options.recoverAfterMillis ?? 30_000;
  const malformedBudget = options.malformedBudget ?? 3;

  const sessions = new Map<string, EngineSession>();
  const resolvers = makeResolvers(driver, term, context);
  const observer = Context.getOption(context, Events);
  const ambientStore = Context.getOption(context, PersistentRef.Store);
  // Minted keys are PROCESS-UNIQUE, not just engine-unique: session
  // identity leaks into the world (workspace checkouts key on
  // `AI.Thread.key`), so a bare counter would collide across restarts.
  const mintPrefix = crypto.randomUUID().slice(0, 8);
  let minted = 0;
  let lastKey: string | undefined;

  const metaOf = (s: EngineSession): SessionMeta => ({
    tick: s.tick,
    observed: s.observed,
    active: [...s.active],
    busy: s.busy,
    settled: s.settledOutcome,
  });

  const putMeta = (s: EngineSession) =>
    s.handle
      .putMeta(metaOf(s))
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `ThreadStorage meta write failed for '${s.key}' of '${term}'`,
            cause,
          ),
        ),
      );

  const observe = (
    s: EngineSession,
    observation: ObservationDraft,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      // live facts (deltas, in-flight tool calls) never persist and
      // never advance the cursor
      const live = isLiveObservation(observation.type);
      const full = {
        ...observation,
        term,
        key: s.key,
        seq: live ? s.observed : s.observed++,
        at: Date.now(),
      } as SessionObservation;
      if (!live) {
        // the durable row and its cursor persist together — a failed
        // write costs restart fidelity, not the round
        yield* s.handle
          .appendObservation(full, metaOf(s))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `ThreadStorage append failed for '${s.key}' of '${term}'`,
                cause,
              ),
            ),
          );
      }
      yield* Effect.ignore(
        broadcast(s.key, {
          type: "observation",
          durable: !live,
          observation: full,
        }),
      );
      if (Option.isSome(observer)) {
        yield* observer.value.emit(full).pipe(Effect.ignore);
      }
    });

  const appendThread = (
    s: EngineSession,
    messages: ReadonlyArray<Prompt.MessageEncoded>,
  ): Effect.Effect<void> =>
    messages.length === 0
      ? Effect.void
      : s.handle
          .appendMessages(messages)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `ThreadStorage append failed for '${s.key}' of '${term}'`,
                cause,
              ),
            ),
          );

  // ── the session-scoped AI.Thread / AI.Tick services ──────────────
  const makeThreadService = (s: EngineSession): ThreadService => ({
    key: s.key,
    tokens: Effect.map(s.handle.messages, (rows) =>
      Math.ceil(JSON.stringify(rows).length / 4),
    ),
    entries: Effect.map(
      s.handle.messages,
      (rows) => Prompt.make([...rows]).content,
    ),
    compact: (plan) =>
      Effect.sync(() => {
        s.pendingCompaction = plan;
      }),
    // ANSWER the current round, from wherever the answer is produced
    // (usually a tool handler) — the caller resolves now; the session
    // neither parks nor ends
    reply: (value) =>
      Effect.forEach(
        s.roundWaiters.splice(0),
        (waiter) => Deferred.succeed(waiter, value),
        { discard: true },
      ),
    // the engine's CLOCK, through the placement's scheduler — a
    // sleeping fiber locally, an alarm row on DOs. Delivery is an
    // ordinary inbox message: a wake if parked, queued if busy,
    // dropped if settled.
    remind: (delay, note) =>
      options.remind(s.key, Date.now() + Duration.toMillis(delay), note),
  });

  const makeTickService = (s: EngineSession): TickService => ({
    count: s.tick,
    say: (note) =>
      Effect.sync(() => {
        s.pendingNotes.push(note);
      }),
  });

  /** Provide the engine-owned services to RUNTIME charter code. */
  const provideSession =
    (s: EngineSession) =>
    <A, E>(effect: Effect.Effect<A, E, any>): Effect.Effect<A, E> =>
      effect.pipe(
        Effect.provideService(Thread, makeThreadService(s)),
        Effect.provideService(Tick, makeTickService(s)),
        Effect.provideService(PersistentRef.Store, s.stateStore),
        // the FRAME: refs are namespaced by the session's identity
        PersistentRef.within(term, s.key),
        Effect.provide(RuntimeContext.phantom),
        Effect.provide(context),
      ) as Effect.Effect<A, E>;

  /** The INIT evaluation context — `AI.Thread` but deliberately NOT
   *  `AI.Tick`: no sampling is under way during init. */
  const provideInit =
    (s: EngineSession) =>
    <A, E>(effect: Effect.Effect<A, E, any>): Effect.Effect<A, E> =>
      effect.pipe(
        Effect.provideService(Thread, makeThreadService(s)),
        Effect.provideService(PersistentRef.Store, s.stateStore),
        PersistentRef.within(term, s.key),
        Effect.provide(RuntimeContext.phantom),
        Effect.provide(context),
      ) as Effect.Effect<A, E>;

  /** The host adapter the shared algorithm consumes. */
  const makeOps = (s: EngineSession): SessionOps => ({
    driver,
    term,
    key: s.key,
    context,
    provide: provideSession(s),
    turn: () => s.turn!,
    tick: () => s.tick,
    clearNotes: () => {
      s.pendingNotes.length = 0;
    },
    observe: (draft) => observe(s, draft),
    observeLive: (draft) => observe(s, draft),
    activeSkills: () => s.active,
    setSkill: (name, active) =>
      Effect.gen(function* () {
        if (active) s.active.add(name);
        else s.active.delete(name);
        yield* putMeta(s);
      }),
    lastStance: () => s.lastStance,
    setLastStance: (stance) => {
      s.lastStance = stance;
    },
    wireUnion: () => s.wireUnion,
    lastEnvelopeHash: () => s.envelopeHash,
    setLastEnvelopeHash: (hash) => {
      s.envelopeHash = hash;
    },
    registerChild: (agent, childKey, actor) => {
      s.children.set(`${agent}:${childKey}`, { key: childKey, actor });
    },
    spawn: (params) => spawn(s, params),
    wrapHandler: options.wrapHandler,
  });

  const makeShell = (key: string): Effect.Effect<EngineSession> =>
    Effect.gen(function* () {
      return {
        key,
        handle: yield* storage.open(term, key),
        gate: yield* Semaphore.make(1),
        tick: 0,
        observed: 0,
        active: new Set<string>(),
        settledSignal: yield* Deferred.make<unknown>(),
        pendingNotes: [],
        wireUnion: new Map<string, AiTool.Any>(),
        pendingWaiters: [],
        roundWaiters: [],
        children: new Map(),
        stateStore:
          options.stateStore !== undefined
            ? options.stateStore(key)
            : Option.isSome(ambientStore)
              ? ambientStore.value
              : PersistentRef.makeMemoryStore(),
      };
    });

  /**
   * Create-or-restore one session's RAM shell. A persisted meta seeds
   * the cursors (the same code path serves cold restore and a DO
   * re-activation); a fresh key emits `admitted` and runs the
   * charter's per-session INIT.
   */
  /** In-flight creations, so two concurrent verbs for a fresh key
   *  never double-create the shell (double `admitted`, split waiters). */
  const creating = new Map<string, Deferred.Deferred<EngineSession, unknown>>();

  const ensureSession = (
    key?: string,
    parent?: { readonly term: string; readonly key: string },
  ): Effect.Effect<EngineSession> =>
    Effect.gen(function* () {
      const sessionKey = key ?? `session-${mintPrefix}-${minted++}`;
      lastKey = sessionKey;
      const existing = sessions.get(sessionKey);
      if (existing !== undefined) return existing;
      const inflight = creating.get(sessionKey);
      if (inflight !== undefined) {
        return yield* Effect.orDie(Deferred.await(inflight));
      }
      const gate = yield* Deferred.make<EngineSession, unknown>();
      creating.set(sessionKey, gate);
      const built = yield* Effect.exit(buildSession(sessionKey, parent));
      creating.delete(sessionKey);
      yield* Deferred.done(gate, built);
      if (Exit.isFailure(built)) {
        return yield* Effect.failCause(built.cause);
      }
      return built.value;
    }) as Effect.Effect<EngineSession>;

  const buildSession = (
    sessionKey: string,
    parent?: { readonly term: string; readonly key: string },
  ): Effect.Effect<EngineSession> =>
    Effect.gen(function* () {
      let s = sessions.get(sessionKey);
      if (s === undefined) {
        s = yield* makeShell(sessionKey);
        const meta = yield* s.handle.meta.pipe(
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logWarning(
                `ThreadStorage meta read failed for '${sessionKey}' of '${term}'`,
                cause,
              ),
              undefined,
            ),
          ),
        );
        if (meta === undefined) {
          yield* observe(s, { type: "admitted", parent });
        } else {
          s.tick = meta.tick;
          s.observed = meta.observed;
          for (const skill of meta.active) s.active.add(skill);
          s.busy = meta.busy;
          s.settledOutcome = meta.settled;
          if (meta.settled !== undefined) {
            yield* Deferred.succeed(s.settledSignal, meta.settled.outcome);
          }
        }
        // per-session init: the thread exists (Thread in scope for
        // thread-scoped setup); no sampling yet (no Tick)
        const shell = s;
        const initResult = yield* provideInit(shell)(
          charter as Effect.Effect<unknown, unknown>,
        ).pipe(
          // an init that fails (a checkout that cannot converge, a
          // machine that will not boot) is a session that never
          // answers — leave the durable WHY in the transcript before
          // dying, so the viewer sees the crash instead of silence.
          // The shell is not registered, so the next submit retries.
          Effect.tapCause((cause) =>
            observe(shell, {
              type: "crashed",
              error: describeCrash(cause).encoded,
              fatal: true,
            }),
          ),
          Effect.orDie,
        );
        s.turn = isFragment(initResult)
          ? Effect.succeed(initResult)
          : Effect.isEffect(initResult)
            ? (initResult as Turn)
            : typeof initResult === "function"
              ? (initResult as TurnFn)
              : yield* Effect.die(
                  `${driver}: the charter for '${term}' returned neither prose, a turn effect, nor a turn function`,
                );
        sessions.set(sessionKey, s);
      }
      return s;
    });

  /** Queue one input; pair a dispatch waiter to its inbox seq. */
  const enqueue = (
    s: EngineSession,
    input: unknown,
    enqueueOptions?: {
      readonly waiter?: Deferred.Deferred<unknown, unknown>;
      readonly quiet?: boolean;
    },
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const seq = yield* s.handle.putInbox(input, {
        quiet: enqueueOptions?.quiet,
      });
      if (enqueueOptions?.waiter !== undefined) {
        s.pendingWaiters.push({ seq, waiter: enqueueOptions.waiter });
      }
    });

  const failAllWaiters = (s: EngineSession, error: unknown) =>
    Effect.forEach(
      [
        ...s.roundWaiters.splice(0),
        ...s.pendingWaiters.splice(0).map((entry) => entry.waiter),
      ],
      (waiter) => Deferred.fail(waiter, error),
      { discard: true },
    );

  const resolveRoundWaiters = (s: EngineSession, value: unknown) =>
    Effect.forEach(
      s.roundWaiters.splice(0),
      (waiter) => Deferred.succeed(waiter, value),
      { discard: true },
    );

  /** The SUPERVISION cascade: a settled session settles every session
   *  worker it dispatched. */
  const settleChildren = (s: EngineSession): Effect.Effect<void> =>
    Effect.forEach(
      [...s.children.values()],
      ({ key: childKey, actor }) =>
        Effect.ignore(
          actor
            .settle(childKey, { supervisor: { term, key: s.key } })
            .pipe(Effect.provide(RuntimeContext.phantom)),
        ),
      { discard: true },
    ).pipe(Effect.andThen(Effect.sync(() => s.children.clear())));

  // the intrinsic spawn: an ANONYMOUS session with the spawner's
  // system prompt REPLACED by the written role, and a subset of the
  // spawner's CURRENT tick's tools/skills — never spawn/dispatch
  // (workers are leaves). The spawn call itself drives the worker's
  // rounds, so no placement machinery is needed — spawn works on
  // every substrate.
  const spawn = (
    spawner: EngineSession,
    params: SpawnParams,
  ): Effect.Effect<unknown, unknown> =>
    Effect.gen(function* () {
      const stance = spawner.lastStance!;
      const worker = yield* makeShell(`spawn-${mintPrefix}-${minted++}`);
      sessions.set(worker.key, worker);
      const handlers: Record<string, (params: any) => Effect.Effect<any, any>> =
        {};
      const granted: Array<AiTool.Any> = [];
      const grantedNames = params.tools ?? [...stance.tools.keys()];
      for (const name of grantedNames) {
        const compiled = stance.tools.get(name);
        if (compiled === undefined) continue;
        granted.push(compileTool(compiled.term));
        const resolved = yield* resolvers.resolveHandler(compiled);
        handlers[name] = (input) => provideSession(worker)(resolved(input));
      }
      // handed skills arrive PRE-ACTIVATED: prose joins the worker's
      // instructions, tools join its (fixed) toolkit
      const handed: Array<{ name: string } & ResolvedSkill> = [];
      for (const name of params.skills ?? []) {
        const skillTerm = stance.skills.get(name);
        if (skillTerm === undefined) continue;
        const resolved = yield* resolvers.resolveSkill(skillTerm);
        handed.push({ name, ...resolved });
        for (const [toolName, fn] of Object.entries(resolved.handlers)) {
          handlers[toolName] ??= (input) => provideSession(worker)(fn(input));
        }
      }
      const tools = dedupeByName([
        ...granted,
        ...handed.flatMap((skill) => [...skill.tools]),
      ]);
      const system = [
        params.instructions,
        ...handed.map((skill) => `## Skill: ${skill.name}\n\n${skill.prose}`),
      ].join("\n\n");
      const toolkit = yield* buildToolkit(
        tools,
        handlers,
        options.wrapHandler === undefined
          ? undefined
          : { wrapHandler: options.wrapHandler },
      );
      worker.fixedTick = { system, toolkit };
      const waiter = yield* Deferred.make<unknown, unknown>();
      yield* enqueue(worker, params.task, { waiter });
      // the spawn call DRIVES the worker — its rounds run inside this
      // handler, and the waiter resolves at the worker's quiescence
      yield* burst(worker.key);
      return yield* Deferred.await(waiter);
    });

  /**
   * ONE BURST: run rounds for a session until it parks or settles —
   * serialized per session, safe to call redundantly (a kick with
   * nothing to do parks immediately). This is the whole execution
   * model on every substrate; placements only decide WHEN to call it.
   */
  const burst = (key: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const s = yield* ensureSession(key);
      // the crash is DELIVERED by onCrash (observation, waiters,
      // re-entry scheduling) — the burst itself never fails, so a
      // kicking verb can never be poisoned by the round it kicked
      yield* s.gate.withPermits(1)(
        rounds(s).pipe(Effect.tapCause((cause) => onCrash(s, cause))),
      );
    }).pipe(
      // TOTAL containment, ensure included: a burst often rides a
      // host's fire-and-forget channel (workerd's waitUntil), where a
      // rejected promise RESETS the Durable Object — a burst must
      // never reject, only log
      Effect.catchCause((cause) =>
        Effect.logError(`${driver}: burst for '${key}' failed`, cause),
      ),
    ) as Effect.Effect<void>;

  const rounds = (s: EngineSession) =>
    Effect.gen(function* () {
      if (s.settledOutcome !== undefined) return;

      // ── recovery: a busy marker on ENTRY means the previous
      // attempt DIED mid-round — eviction, restart, or crash, all
      // indistinguishable on disk and all re-entered the same way.
      // (The gate makes this unambiguous: a healthy predecessor
      // clears the marker before releasing.) Bounded re-entry:
      // progress resets the budget; exhaustion abandons the round
      // VISIBLY and the session keeps serving.
      let recovering = false;
      if (s.busy !== undefined) {
        const attempts = s.busy.attempts + 1;
        if (attempts > maxAttempts) {
          yield* appendThread(s, [
            noteMessage(
              `This round was interrupted ${maxAttempts} times and has been abandoned — the messages above it may be unanswered. Continuing fresh from here.`,
            ),
          ]);
          yield* observe(s, {
            type: "input",
            text: `<note>\nround abandoned after ${maxAttempts} interrupted attempts\n</note>`,
            kind: "note",
          });
          s.busy = undefined;
          yield* putMeta(s);
          const abandoned = new RoundAbandoned({
            term,
            key: s.key,
            attempts: maxAttempts,
          });
          yield* observe(s, {
            type: "crashed",
            error: {
              _tag: abandoned._tag,
              message: abandoned.message,
              retryable: false,
            },
            fatal: true,
          });
          // exhaustion is the ONE defect-lane crash that answers
          // waiters — as a TYPED failure the caller can catch
          yield* failAllWaiters(s, abandoned);
        } else {
          s.busy = { attempts, since: Date.now() };
          yield* putMeta(s);
          yield* scheduleReentry(
            s.key,
            recoverAfter * 2 ** Math.min(attempts, 3),
          );
          recovering = true;
          // INFORMED re-decision, without transcript surgery: the
          // interrupted attempt's tool calls never persisted (only
          // complete samplings append), so the re-sample would
          // otherwise repeat side effects blind.
          yield* appendThread(s, [
            noteMessage(
              `The previous attempt at this work was interrupted mid-sampling (attempt ${attempts} of ${maxAttempts}). Any actions it took may or may not have completed — verify before repeating anything with side effects.`,
            ),
          ]);
          yield* observe(s, {
            type: "interrupted",
            attempt: attempts,
            maxAttempts,
          });
          yield* Effect.logInfo(
            `${driver} session '${term}/${s.key}': recovering an interrupted round (attempt ${attempts}/${maxAttempts})`,
          );
        }
      }

      const ops = makeOps(s);
      /**
       * Whether the LAST sampling was quiescent. An empty inbox is
       * only a park if it is — a sampling that called tools must come
       * back around to read their results, with no new input at all.
       * Starts `true` so a burst kicked with nothing to do parks
       * instead of sampling — unless it is RECOVERING an interrupted
       * round, whose inputs are already in the thread and owed a
       * reply.
       */
      let quiescent = !recovering;
      // consecutive malformed-tool-call feedback rounds — resets on
      // any well-formed sampling
      let malformed = 0;

      while (true) {
        if (s.settledOutcome !== undefined) break;
        const rows = yield* s.handle.listInbox;
        // QUIET rows never open a round: a parked session with only
        // quiet inputs queued stays parked — they join whichever
        // round a WAKING input (or an already-open round) drains
        const waking = rows.some((row) => row.quiet !== true);
        if (!waking && quiescent) {
          // PARKED: the session's work is done until the world moves.
          // Everything durable is already written through the handle,
          // so parking is just returning — the placement decides who
          // waits (a resident fiber) or who returns (a DO event).
          yield* observe(s, { type: "parked" });
          break;
        }
        // boundary work: requested compaction applies BEFORE the new
        // inputs join the thread, so nothing fresh is lost
        yield* Effect.suspend(() => {
          const plan = s.pendingCompaction;
          if (plan === undefined) return Effect.void;
          s.pendingCompaction = undefined;
          return applyCompactionPlan(s.handle, plan);
        });
        const drained = rows.map((row) => inputProvenance(row.input));
        const inputs = drained.map((item) => item.value);
        if (rows.length > 0) {
          const maxSeq = rows[rows.length - 1]!.seq;
          // drained waiters JOIN THE ROUND: only now are they
          // answerable — by AI.reply, or by quiescence as fallback
          for (let index = s.pendingWaiters.length - 1; index >= 0; index--) {
            const entry = s.pendingWaiters[index]!;
            if (entry.seq <= maxSeq) {
              s.pendingWaiters.splice(index, 1);
              s.roundWaiters.push(entry.waiter);
            }
          }
          // the ATOMIC ADMIT: inputs into the thread, watermark past
          // them, the round OPENED (busy) — one write; every crash
          // point around it converges
          s.busy = s.busy ?? { attempts: 0, since: Date.now() };
          yield* s.handle.admit({
            messages: drained.map((item) => asUserMessage(item.value)),
            drainedTo: maxSeq + 1,
            meta: metaOf(s),
          });
          // the round is now OWED: guarantee re-entry even if this
          // very attempt dies without a crash handler (a hard isolate
          // death mid-sampling) — a stale re-entry just parks
          yield* scheduleReentry(s.key, recoverAfter);
          yield* s.handle
            .deleteInbox(rows.map((row) => row.seq))
            .pipe(Effect.ignore);
          for (const { value, kind } of drained) {
            yield* observe(s, {
              type: "input",
              text: typeof value === "string" ? value : JSON.stringify(value),
              kind,
            });
          }
        }

        // TICK — the shared algorithm renders this sampling's stance
        // and assembles its toolkit (spawn workers sample a constant)
        const tick =
          s.fixedTick !== undefined
            ? s.fixedTick
            : yield* compileTick(ops, resolvers, inputs);

        // deliver collected notes (`AI.say`): a PLAIN append, in
        // emission order — the author's condition IS the policy
        for (const note of s.pendingNotes.splice(0)) {
          const text = render(note.template as TemplateStringsArray, [
            ...note.refs,
          ]);
          if (text.length === 0) continue;
          yield* appendThread(s, [noteMessage(text)]);
          yield* observe(s, {
            type: "input",
            text: `<note>\n${text}\n</note>`,
            kind: "note",
          });
        }

        const outcome = yield* sampleTick({
          ops,
          languageModel,
          handle: s.handle,
          tick,
          exhausted: malformed >= malformedBudget,
        });
        if (outcome.kind === "malformed") {
          malformed++;
          quiescent = false; // come straight back around and re-sample
          continue;
        }
        malformed = 0;
        const response = outcome.response;
        s.tick++;
        quiescent = response.toolCalls.length === 0;
        // PROGRESS: a completed sampling resets the recovery budget;
        // a quiescent one closes the round entirely
        s.busy = quiescent ? undefined : { attempts: 0, since: Date.now() };
        yield* putMeta(s);
        if (quiescent) {
          yield* resolveRoundWaiters(s, response.text);
        } else {
          yield* scheduleReentry(s.key, recoverAfter);
        }
      }
    });

  /**
   * A crashed burst never strands its callers, and never ends the
   * session: a DETERMINISTIC failure (billing, auth, content policy)
   * abandons the round NOW and fails waiters with the ORIGINAL typed
   * error (catchable by tag); a transient one leaves the round OWED —
   * the scheduled re-entry recovers it and answers the waiters at
   * quiescence.
   */
  const onCrash = (s: EngineSession, cause: Cause.Cause<unknown>) =>
    Effect.gen(function* () {
      yield* Effect.logError(
        `${driver} session '${term}/${s.key}' crashed`,
        cause,
      );
      const crash = describeCrash(cause);
      yield* observe(s, {
        type: "crashed",
        error: crash.encoded,
        fatal: !crash.encoded.retryable,
      });
      if (!crash.encoded.retryable) {
        const line =
          crash.encoded._tag !== undefined
            ? `${crash.encoded._tag}: ${crash.encoded.message}`
            : crash.encoded.message;
        yield* appendThread(s, [
          noteMessage(
            `The previous round failed with a non-retryable error ` +
              `(${line}) and was abandoned rather than retried. ` +
              `The messages above it may be unanswered.`,
          ),
        ]);
        s.busy = undefined;
        yield* putMeta(s);
        yield* failAllWaiters(s, crash.error);
        return;
      }
      // the round is still OWED: guarantee the wake is coming — a
      // crash before the drain opened the round would otherwise
      // leave no re-entry scheduled and a caller parked forever
      if (s.busy === undefined && s.settledOutcome === undefined) {
        s.busy = { attempts: 0, since: Date.now() };
        yield* putMeta(s);
      }
      yield* scheduleReentry(
        s.key,
        recoverAfter * 2 ** Math.min(s.busy?.attempts ?? 0, 3),
      );
    });

  const settle = (
    key: string,
    outcomeValue: unknown,
    settleOptions?: { readonly admit?: boolean },
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      let s = sessions.get(key);
      if (s === undefined) {
        if (settleOptions?.admit !== true) return;
        s = yield* ensureSession(key);
      }
      // idempotent: a second settle changes nothing
      if (s.settledOutcome !== undefined) return;
      s.settledOutcome = { outcome: outcomeValue };
      // busy dies with the session — a settled session must not keep
      // recovery re-entering it
      s.busy = undefined;
      yield* putMeta(s);
      yield* observe(s, { type: "settled" });
      // anyone still waiting gets the outcome — the current round's
      // waiters AND undrained arrivals alike
      yield* Effect.forEach(
        [
          ...s.roundWaiters.splice(0),
          ...s.pendingWaiters.splice(0).map((entry) => entry.waiter),
        ],
        (waiter) => Deferred.succeed(waiter, outcomeValue),
        { discard: true },
      );
      yield* Deferred.succeed(s.settledSignal, outcomeValue);
      yield* settleChildren(s);
    });

  const resume: SessionEngine["resume"] = (key) =>
    Effect.gen(function* () {
      // admit-or-rehydrate: a hibernated placement's RAM shell is
      // gone but the settled tombstone lives in meta — ensureSession
      // reads it back before we clear it
      const s = yield* ensureSession(key);
      if (s.settledOutcome === undefined) return false;
      s.settledOutcome = undefined;
      // a settled session's busy died with it; a resumed one starts
      // parked, not owing a round
      s.busy = undefined;
      // the old signal already fired (one-shot) — resident placements
      // park their fresh fiber on this new one
      s.settledSignal = yield* Deferred.make<unknown>();
      yield* putMeta(s);
      yield* observe(s, { type: "resumed" });
      return true;
    });

  const admit: SessionEngine["admit"] = (key) =>
    Effect.gen(function* () {
      if (sessions.has(key) || creating.has(key)) return false;
      // a throwaway shell: only its storage handle is used — the
      // durable row + meta land, then the shell is dropped. The
      // first input's `buildSession` reads that meta and seeds a
      // fresh shell from it, never re-admitting.
      const s = yield* makeShell(key);
      const meta = yield* s.handle.meta.pipe(
        Effect.catchCause((cause) =>
          Effect.as(
            Effect.logWarning(
              `ThreadStorage meta read failed for '${key}' of '${term}'`,
              cause,
            ),
            undefined,
          ),
        ),
      );
      if (meta !== undefined) return false;
      yield* observe(s, { type: "admitted" });
      return true;
    });

  const send: SessionEngine["send"] = (input, sendOptions) =>
    Effect.gen(function* () {
      const s = yield* ensureSession(sendOptions?.key, sendOptions?.parent);
      if (s.settledOutcome !== undefined) return;
      // QUIET delivery (`wake: false`): the row is durable in the
      // inbox but marked quiet and nothing is kicked — a parked
      // session stays parked; whatever opens the next round drains
      // everything accumulated
      const quiet = sendOptions?.wake === false;
      yield* enqueue(s, input, { quiet });
      if (!quiet) {
        yield* kick(s.key);
      }
    });

  const dispatch: SessionEngine["dispatch"] = (input, dispatchOptions) =>
    Effect.gen(function* () {
      const s = yield* ensureSession(
        dispatchOptions?.key,
        dispatchOptions?.parent,
      );
      if (s.settledOutcome !== undefined) return s.settledOutcome.outcome;
      // the waiter RIDES the input (paired by inbox seq): it joins
      // the answerable round only when its own message is drained, so
      // an in-flight earlier round can never answer it
      const waiter = yield* Deferred.make<unknown, unknown>();
      yield* enqueue(s, input, { waiter });
      yield* kick(s.key);
      return yield* Deferred.await(waiter);
    });

  const steer: SessionEngine["steer"] = (key, input) =>
    Effect.gen(function* () {
      const target = key ?? lastKey;
      if (target === undefined) return;
      const s = sessions.get(target);
      if (s === undefined) {
        // crash recovery: a KEYED steer must never be silently
        // dropped — the session's RAM shell died but the world's
        // event is real; admit a fresh session
        if (key !== undefined) {
          yield* send(input, { key });
        }
        return;
      }
      if (s.settledOutcome !== undefined) return;
      yield* enqueue(s, input);
      yield* kick(s.key);
    });

  const restore: SessionEngine["restore"] = Effect.gen(function* () {
    const persisted = yield* storage
      .keys(term)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.as(
            Effect.logWarning(
              `ThreadStorage restore failed for '${term}'`,
              cause,
            ),
            [] as ReadonlyArray<string>,
          ),
        ),
      );
    const revived: Array<string> = [];
    for (const key of persisted) {
      if (sessions.has(key)) continue;
      // spawn workers are not restorable: their stance was a runtime
      // grant of the spawner's tick, not the charter
      if (key.startsWith("spawn-")) continue;
      yield* ensureSession(key);
      revived.push(key);
    }
    if (revived.length > 0) {
      yield* Effect.logInfo(
        `Driver '${term}': restored ${revived.length} session(s) parked`,
      );
    }
    return revived;
  });

  const socketHost: SessionEngine["socketHost"] = (key) =>
    Effect.gen(function* () {
      // VIEWING is storage-only. Replay and the watermark read the
      // durable rows directly — never through `ensureSession`, which
      // builds the shell and runs the charter's per-session INIT (for
      // a sandboxed agent: boot the machine, converge the checkout).
      // A transcript must not wait on that, and must not vanish when
      // it fails: a viewer that attached to a session whose machine
      // was wedged saw an empty chat for minutes, then nothing. Only
      // `submit` needs the built session, and builds it lazily.
      const resident = sessions.get(key);
      const handle = resident?.handle ?? (yield* storage.open(term, key));
      return {
        replay: (fromSeq) => handle.observations(fromSeq),
        watermark:
          resident !== undefined
            ? Effect.sync(() => resident.observed)
            : Effect.map(handle.meta, (meta) => meta?.observed ?? 0),
        // the socket's steer: admit input; the answer arrives as
        // observations, never as a response
        submit: (input) =>
          Effect.gen(function* () {
            const s = yield* ensureSession(key);
            if (s.settledOutcome !== undefined) return;
            yield* enqueue(s, input);
            yield* kick(s.key);
          }),
      } satisfies SessionSocketHost;
    });

  return {
    send,
    dispatch,
    steer,
    settle,
    resume,
    admit,
    interrupt: Effect.suspend(() =>
      Effect.forEach(
        [...sessions.keys()],
        (key) => settle(key, { interrupted: true }),
        { discard: true },
      ),
    ),
    forget: (key) =>
      Effect.sync(() => {
        sessions.delete(key);
        if (lastKey === key) lastKey = undefined;
      }),
    burst,
    restore,
    ensure: (key) => Effect.map(ensureSession(key), (s) => s.key),
    socketHost,
    awaitSettled: (key) =>
      Effect.flatMap(ensureSession(key), (s) =>
        Deferred.await(s.settledSignal),
      ),
  };
};
