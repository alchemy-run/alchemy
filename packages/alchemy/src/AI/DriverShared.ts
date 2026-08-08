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
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import { isAiError } from "effect/unstable/ai/AiError";
import type * as Prompt from "effect/unstable/ai/Prompt";
import * as AiTool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import { isAgent, type Agent } from "./Agent.ts";
import type { DispatchTool } from "./Dispatch.ts";
import { isEvent } from "./Event.ts";
import type { EncodedCrash } from "./Observer.ts";
import { isParameter } from "./Parameter.ts";
import { dedentTemplate } from "./Prose.ts";
import { isSkill, type Skill } from "./Skill.ts";
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
