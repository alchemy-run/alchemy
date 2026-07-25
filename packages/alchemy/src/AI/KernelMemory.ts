import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";
import * as Stream from "effect/Stream";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Prompt from "effect/unstable/ai/Prompt";
import * as Response from "effect/unstable/ai/Response";
import * as AiTool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import { RuntimeContext } from "../RuntimeContext.ts";
import type { Actor } from "./Actor.ts";
import { isAgent, type Agent } from "./Agent.ts";
import { Refused } from "./Errors.ts";
import { isEvent } from "./Event.ts";
import {
  Kernel,
  type Charter,
  type Interpretable,
  type Turn,
} from "./Kernel.ts";
import { KernelObserver, type KernelObservation } from "./Observer.ts";
import { isParameter } from "./Parameter.ts";
import { dedentTemplate, isFragment, type Fragment } from "./Prose.ts";
import { isSkill, type Skill, type SkillService } from "./Skill.ts";
import {
  Thread,
  Tick,
  type CompactPlan,
  type ThreadService,
  type TickService,
} from "./Thread.ts";
import { isTool, isToolImpl, type Tool } from "./Tool.ts";
import { WireMode, type WirePresentation } from "./WireMode.ts";

/** `Omit` distributed over a union (plain `Omit` collapses it). */
type DistributiveOmit<T, K extends PropertyKey> = T extends any
  ? Omit<T, K>
  : never;

/**
 * Render a capability term's own tagged template into prose (a tool's
 * description, a skill's teaching, a parameter's field description).
 * Capability terms render as their NAME (backticked, so the model sees
 * the same identifier the toolkit declares); anything else renders as
 * its string value.
 */
const renderRef = (ref: unknown): string => {
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

const render = (template: TemplateStringsArray, refs: ReadonlyArray<any>) => {
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
 * Every kernel-compiled tool is annotated `Strict: false`: providers
 * that default to strict structured-output tool calling (Anthropic)
 * compile each schema through a grammar whose codec rewrites every
 * optional parameter into a required nullable union AND caps
 * union-typed parameters per request (16) — a working toolkit (the
 * Coding skill alone carries ~20 optional params) cannot fit. The
 * kernel's toolkits are dynamic and open-ended, so strict grammars
 * are the wrong trade; non-strict tool calling has no such limit.
 */
const compileTool = (term: Tool<any, any[]>) => {
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
 * prose hired. The task must stand alone because the delegate's run is
 * its OWN conversation (fresh key, fresh transcript); the delegate
 * never sees the host's.
 */
const compileDispatch = (names: ReadonlyArray<string>) =>
  AiTool.make("dispatch", {
    description:
      `Hand one task to another agent and await their answer. ` +
      `Available agents: ${names.join(", ")}. State the task ` +
      `completely — the agent sees only what you write here, never ` +
      `this conversation.`,
    parameters: S.Struct({
      agent: S.Literals(names as [string, ...string[]]),
      task: S.String,
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
const compileSpawn = (
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
 * needed) and enables its tools for the rest of the run; deactivating
 * retires them — the agent manages its own working set.
 */
const compileSkillTool = (names: ReadonlyArray<string>) =>
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
const asUserMessage = (input: unknown): Prompt.MessageEncoded => ({
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
const noteMessage = (body: string): Prompt.MessageEncoded => ({
  role: "user",
  content: [{ type: "text", text: `<note>\n${body}\n</note>` }],
});

/**
 * Appended to every system prompt: how to read the one kernel-authored
 * channel. Constant text — a static charter's system prompt stays
 * byte-stable for prompt caching.
 */
const NOTE_CODA = `

---
As work proceeds, <note> messages may arrive — point-in-time remarks from the process hosting this work.`;

/** First occurrence wins — a shared tool appears once in a toolkit. */
const dedupeByName = (tools: ReadonlyArray<AiTool.Any>): Array<AiTool.Any> => {
  const seen = new Set<string>();
  return tools.filter((tool) =>
    seen.has(tool.name) ? false : (seen.add(tool.name), true),
  );
};

/** One tool mention in a rendered stance — tagged or inline. */
interface CompiledToolRef {
  readonly term: Tool<any, any[]>;
  /** Inline (closure) implementation — bypasses context resolution. */
  readonly impl?: (params: any) => Effect.Effect<any, any, any>;
}

/**
 * One tick's rendered stance: the document (as BLOCKS, the diffing
 * granularity) and the capabilities its prose mentioned.
 */
interface Stance {
  readonly blocks: ReadonlyArray<string>;
  readonly tools: Map<string, CompiledToolRef>;
  readonly skills: Map<string, Skill<string, any>>;
  readonly delegates: Map<string, Agent<any, any>>;
}

interface RunState {
  readonly inbox: Queue.Queue<unknown>;
  /** Dispatch waiters — each resolves at the run's next quiescence. */
  readonly waiters: Array<Deferred.Deferred<unknown>>;
  /** The run's ending: `settle` from outside, or a turn Outcome. */
  readonly settled: Deferred.Deferred<unknown>;
  /** World identity (`owner/repo#7`) or kernel-minted. */
  readonly key: string;
  /** Skills this run has activated (effective when also mentioned). */
  readonly active: Set<string>;
  /** Samplings performed so far. */
  tick: number;
  /** The thread — everything after the (separate) frozen head. */
  prompt: Prompt.Prompt;
  /** The run's TURN, produced by its own charter init. */
  turn?: Turn;
  /** Requested compaction; applied at the next tick's start. */
  pendingCompaction?: CompactPlan;
  /** Notes collected via `AI.say`, awaiting delivery this tick. */
  readonly pendingNotes: Array<Fragment>;
  /** Next observation sequence number (the observer's cursor). */
  observed: number;
  /** The last rendered stance — what `spawn`/`skill` grant from. */
  lastStance?: Stance;
}

/** What one tick hands the loop. */
type TickResult =
  | { readonly outcome: { readonly value: unknown } }
  | {
      readonly system: string;
      readonly toolkit: Toolkit.WithHandler<any> | undefined;
    };

/**
 * The in-memory Kernel: the smallest interpreter that makes a charter
 * LIVE. One Layer, one requirement (`LanguageModel`) — every other
 * capability (durability, tracing, passivation, scheduling) is a Layer
 * to be added around it later, never a feature of the loop.
 *
 * What `interpret(term, charter)` builds:
 *
 * - the Actor is a keyed map of RUNS. The charter's INIT runs once per
 *   RUN, on first admission of its key — the init closure is the run's
 *   instance (plain `Ref`s for state, inline tools closing over them)
 *   — and yields the run's TURN. A static charter (`AI.prose`) lifts
 *   to a constant turn.
 * - Before EVERY sampling the turn is re-evaluated. A `Fragment`
 *   result IS the system prompt, verbatim — no diffing, no derived
 *   messages: keep it static (the recommended discipline) and it is
 *   byte-stable for prompt caching; change it and the system prompt
 *   simply changes. Its mentions are the tick's toolkit. Everything
 *   dynamic reaches the thread through EXPLICIT channels: `AI.say`
 *   notes, tool results, and steers. Any OTHER value settles the run
 *   from inside; a `Refused` failure is the run giving up.
 * - `AI.Run` is provided to init, turn, and tool handlers: kernel
 *   facts (key, tick, tokens) plus read-only thread access and the one
 *   thread mutation — `compact`, applied at tick boundaries only.
 *
 * ```
 * loop: drain mailbox → apply pending compaction → user messages
 *       TICK: evaluate turn → outcome? settle : render stance → diff → toolkit
 *       generateText(head + thread, toolkit)   (tools run inside)
 *       append response parts
 *       tool calls?  → loop                    (the agentic loop)
 *       quiescent    → resolve dispatch waiters with the text,
 *                      PARK: wait for steer/send (wake) or settle (end)
 * ```
 *
 * Steering is delivered at the SAMPLING BOUNDARY — queued while a
 * step is in flight, spliced as a user message before the next model
 * call, never aborting in-flight work. A keyed steer to an UNKNOWN key
 * admits a fresh run (crash recovery: re-polled events must never be
 * silently dropped). `settle` ends a run idempotently from the
 * outside; a settled run ignores further input and answers late
 * dispatches with its outcome. Transient sampling/turn failures retry
 * with capped backoff before failing the run.
 */
export const KernelMemory: Layer.Layer<
  Kernel,
  never,
  LanguageModel.LanguageModel
> = Layer.effect(
  Kernel,
  Effect.gen(function* () {
    const model = yield* LanguageModel.LanguageModel;

    const interpret = (term: Interpretable, charter: Charter) =>
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const context = yield* Effect.context<never>();
        const termName = term["~alchemy/Name"];

        // the observability seam (same pattern as WireMode): when an
        // observer is present, run lifecycle facts flow into it —
        // fire-and-forget, an observer can never fail or slow a run.
        // Each run's observations carry a monotonic `seq`, the
        // catch-up cursor consumers dedupe and resume by.
        const observer = Context.getOption(context, KernelObserver);
        const observe = (
          run: RunState,
          observation: DistributiveOmit<
            KernelObservation,
            "term" | "key" | "seq" | "at"
          >,
        ): Effect.Effect<void> =>
          Option.isNone(observer)
            ? Effect.void
            : observer.value
                .emit({
                  ...observation,
                  term: termName,
                  key: run.key,
                  seq: run.observed++,
                  at: Date.now(),
                } as KernelObservation)
                .pipe(Effect.ignore);

        // ── the run-scoped AI.Thread / AI.Tick services ─────────────
        const makeThreadService = (run: RunState): ThreadService => ({
          key: run.key,
          tokens: Effect.sync(() =>
            Math.ceil(JSON.stringify(run.prompt.content).length / 4),
          ),
          entries: Effect.sync(() => run.prompt.content),
          compact: (plan) =>
            Effect.sync(() => {
              run.pendingCompaction = plan;
            }),
        });

        const makeTickService = (run: RunState): TickService => ({
          count: run.tick,
          say: (note) =>
            Effect.sync(() => {
              run.pendingNotes.push(note);
            }),
        });

        /**
         * Provide the kernel-owned services to RUNTIME charter code
         * (turns, splices, tool handlers): `AI.Thread`/`AI.Tick` for
         * THIS run, the captured interpret context (so charter
         * dependencies resolve no matter which fiber the code runs
         * on), and the runtime color.
         */
        const provideRun =
          (run: RunState) =>
          <A, E>(effect: Effect.Effect<A, E, any>): Effect.Effect<A, E> =>
            effect.pipe(
              Effect.provideService(Thread, makeThreadService(run)),
              Effect.provideService(Tick, makeTickService(run)),
              Effect.provide(RuntimeContext.phantom),
              Effect.provide(context),
            ) as Effect.Effect<A, E>;

        /**
         * Provide the INIT evaluation context: the captured interpret
         * context, the runtime color, and `AI.Thread` — init runs ONCE
         * PER RUN at admit, when the thread already exists, so
         * thread-scoped setup (state keyed by `thread.key`, a
         * workspace checkout) belongs here. Deliberately NOT
         * `AI.Tick`: no sampling is under way during init.
         * `CharterServices` enforces the Tick exclusion at the type
         * level; an init that sneaks a `yield* AI.Tick` past it dies
         * here with a missing-service defect.
         */
        const provideInit =
          (run: RunState) =>
          <A, E>(effect: Effect.Effect<A, E, any>): Effect.Effect<A, E> =>
            effect.pipe(
              Effect.provideService(Thread, makeThreadService(run)),
              Effect.provide(RuntimeContext.phantom),
              Effect.provide(context),
            ) as Effect.Effect<A, E>;

        /**
         * Wrap a tool handler so its FAILURES are observable in the
         * process log: a failing tool result is model-visible (the
         * agent reacts), but without this the operator sees nothing —
         * a run burning its budget against a broken tool looks like
         * silence from the outside.
         */
        const observedHandler =
          (
            run: RunState,
            name: string,
            fn: (params: any) => Effect.Effect<any, any, any>,
          ) =>
          (input: any) =>
            provideRun(run)(fn(input)).pipe(
              Effect.tapError((error) =>
                Effect.logWarning(
                  `Kernel run '${run.key}' of '${termName}': tool '${name}' failed: ${String(error).slice(0, 500)}`,
                ),
              ),
            );

        // ── lazy capability resolution (context is fixed; memoized) ─
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
                `KernelMemory: no implementation provided for tool '${name}' of '${termName}' — provide the tool's Layer or splice an inline impl`,
              );
            }
            const resolved = Effect.isEffect(service.value)
              ? yield* service.value as Effect.Effect<any>
              : service.value;
            handlerCache.set(name, resolved);
            return resolved as (params: any) => Effect.Effect<any, any, any>;
          });

        interface ResolvedSkill {
          readonly prose: string;
          readonly tools: ReadonlyArray<AiTool.Any>;
          readonly handlers: Record<
            string,
            (params: any) => Effect.Effect<any, any, any>
          >;
          /** Skills the teaching references — exposed on activation. */
          readonly skills: ReadonlyArray<Skill<string, any>>;
        }
        const skillCache = new Map<string, ResolvedSkill>();
        const resolveSkill = (skill: Skill<string, any>) =>
          Effect.gen(function* () {
            const skillName = skill["~alchemy/Name"];
            const cached = skillCache.get(skillName);
            if (cached !== undefined) return cached;
            const service = Context.getOption(context, skill as any);
            if (Option.isNone(service)) {
              return yield* Effect.die(
                `KernelMemory: no implementation provided for skill '${skillName}' referenced by '${termName}'`,
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
                  `KernelMemory: skill '${skillName}' implementation provides no tool '${name}'`,
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
                `KernelMemory: no implementation provided for agent '${name}' referenced by '${termName}'`,
              );
            }
            const actor = service.value as Actor;
            delegateCache.set(name, actor);
            return actor;
          });

        // ── stance rendering: fragment tree → blocks + mentions ─────
        const renderStance = (
          run: RunState,
          root: Fragment,
        ): Effect.Effect<Stance> =>
          Effect.gen(function* () {
            const blocks: Array<string> = [];
            const tools = new Map<string, CompiledToolRef>();
            const skills = new Map<string, Skill<string, any>>();
            const delegates = new Map<string, Agent<any, any>>();
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
                  if (isToolImpl(ref)) {
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
                    const value = yield* provideRun(run)(
                      ref as Effect.Effect<unknown>,
                    );
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
            return { blocks, tools, skills, delegates };
          });

        /**
         * Assemble a toolkit from compiled tools + this tick's
         * handlers. `toHandlers` dies on keys that name no tool in the
         * kit, so exactly the kit's handlers are passed.
         */
        const buildToolkit = (
          tools: ReadonlyArray<AiTool.Any>,
          handlers: Record<string, (params: any) => Effect.Effect<any, any>>,
        ): Effect.Effect<Toolkit.WithHandler<any> | undefined> =>
          tools.length === 0
            ? Effect.succeed(undefined)
            : (Effect.gen(function* () {
                const kit = Toolkit.make(...tools) as Toolkit.Toolkit<any>;
                const subset: Record<string, unknown> = {};
                for (const tool of tools) {
                  subset[tool.name] = handlers[tool.name];
                }
                const handlerContext = yield* kit.toHandlers(subset as any);
                return (yield* Effect.provide(
                  kit as Effect.Effect<Toolkit.WithHandler<any>, never, any>,
                  handlerContext,
                )) as Toolkit.WithHandler<any>;
              }) as Effect.Effect<Toolkit.WithHandler<any> | undefined>);

        // one model step: everything the provider + toolkit do for one
        // sampling — tool handlers execute INSIDE this call. The wire is
        // STREAMED so an observer sees text/thinking tokens as they
        // arrive (`onDelta`); the parts are consolidated back into the
        // non-streaming response shape the loop consumes, block metadata
        // merged across deltas (Anthropic's thinking SIGNATURE arrives
        // as a late empty delta and must survive onto the consolidated
        // reasoning part, or the next request fails). Transient provider
        // failures retry with capped backoff before dying: a 429 must
        // never poison a run key. A retry may replay deltas — the final
        // `assistant` observation is the canonical record.
        const step = (
          prompt: Prompt.Prompt,
          toolkit: Toolkit.WithHandler<any> | undefined,
          onLive: (
            part:
              | { kind: "text" | "reasoning"; delta: string }
              | {
                  kind: "tool-call";
                  id: string;
                  name: string;
                  params: unknown;
                },
          ) => Effect.Effect<void> = () => Effect.void,
        ) =>
          Effect.gen(function* () {
            const parts: Array<unknown> = [];
            // open blocks by stream id (providers interleave by index)
            const open = new Map<
              string,
              { type: "text" | "reasoning"; text: string; metadata: any }
            >();
            yield* Stream.runForEach(
              (
                model.streamText as (
                  options: unknown,
                ) => Stream.Stream<any, unknown>
              )({ prompt, toolkit }),
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
                      const kind =
                        part.type === "text-delta" ? "text" : "reasoning";
                      const block = open.get(part.id) ?? {
                        type: kind as "text" | "reasoning",
                        text: "",
                        metadata: {},
                      };
                      open.set(part.id, block);
                      block.text += part.delta;
                      Object.assign(block.metadata, part.metadata);
                      if (part.delta.length > 0) {
                        yield* onLive({ kind, delta: part.delta });
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
                      yield* onLive({
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
              schedule: Schedule.exponential("1 second"),
              times: 3,
            }),
            Effect.orDie,
          );

        const runs = new Map<string, RunState>();
        // Minted keys are PROCESS-UNIQUE, not just kernel-unique: run
        // identity leaks into the world (workspace checkouts key on
        // `AI.Thread.key`), so a bare counter would collide across
        // restarts — a fresh process's `run-0` would inherit the
        // previous process's `run-0` worktree, stale work included.
        const mintPrefix = crypto.randomUUID().slice(0, 8);
        let minted = 0;
        let lastKey: string | undefined;

        const makeRunState = (key: string): Effect.Effect<RunState> =>
          Effect.gen(function* () {
            return {
              inbox: yield* Queue.unbounded<unknown>(),
              waiters: [],
              settled: yield* Deferred.make<unknown>(),
              key,
              active: new Set<string>(),
              tick: 0,
              prompt: Prompt.empty,
              pendingNotes: [],
              observed: 0,
            };
          });

        /**
         * Apply a requested compaction at the tick boundary. The
         * system prompt is untouched; drops leave an archived marker
         * (restorable eviction — nothing is silently rewritten); reset
         * restarts the thread from one summary note.
         */
        const applyCompaction = (run: RunState): void => {
          const plan = run.pendingCompaction;
          if (plan === undefined) return;
          run.pendingCompaction = undefined;
          if ("reset" in plan) {
            run.prompt = Prompt.make([
              noteMessage(
                `The thread was compacted; it restarts from this summary of prior work:\n${plan.reset.summary}`,
              ),
            ]);
            return;
          }
          const messages = run.prompt.content;
          const kept = messages.filter((entry, i) => !plan.drop(entry, i));
          const dropped = messages.length - kept.length;
          if (dropped === 0) return;
          run.prompt = Prompt.concat(
            Prompt.make([
              asUserMessage(
                `[${dropped} earlier message${dropped === 1 ? "" : "s"} archived by compaction]`,
              ),
            ]),
            Prompt.fromMessages(kept),
          );
        };

        /** The per-run `skill` switch — activation is the run's act. */
        const skillSwitch =
          (run: RunState) =>
          (params: { action: "activate" | "deactivate"; skill: string }) =>
            Effect.gen(function* () {
              if (params.action === "deactivate") {
                run.active.delete(params.skill);
                return `deactivated ${params.skill}`;
              }
              const skillTerm = run.lastStance?.skills.get(params.skill);
              if (skillTerm === undefined) {
                // model-visible: the stance no longer mentions it
                return `no skill named '${params.skill}' is available right now`;
              }
              const resolved = yield* resolveSkill(skillTerm);
              run.active.add(params.skill);
              return resolved.prose;
            });

        // the intrinsic spawn: an ANONYMOUS run with the spawner's
        // system prompt REPLACED by the written role, and a subset of
        // the spawner's CURRENT tick's tools/skills — never
        // spawn/dispatch (workers are leaves). A worker's stance is
        // its written instructions: constant, no turn.
        const spawn = (
          spawner: RunState,
          params: {
            instructions: string;
            task: string;
            tools?: ReadonlyArray<string>;
            skills?: ReadonlyArray<string>;
          },
        ) =>
          Effect.gen(function* () {
            const stance = spawner.lastStance!;
            const worker = yield* makeRunState(
              `spawn-${mintPrefix}-${minted++}`,
            );
            const handlers: Record<
              string,
              (params: any) => Effect.Effect<any, any>
            > = {};
            const granted: Array<AiTool.Any> = [];
            const grantedNames = params.tools ?? [...stance.tools.keys()];
            for (const name of grantedNames) {
              const compiled = stance.tools.get(name);
              if (compiled === undefined) continue;
              granted.push(compileTool(compiled.term));
              const resolved = yield* resolveHandler(compiled);
              handlers[name] = (input) => provideRun(worker)(resolved(input));
            }
            // handed skills arrive PRE-ACTIVATED: prose joins the
            // worker's instructions, tools join its (fixed) toolkit
            const handed: Array<{ name: string } & ResolvedSkill> = [];
            for (const name of params.skills ?? []) {
              const skillTerm = stance.skills.get(name);
              if (skillTerm === undefined) continue;
              const resolved = yield* resolveSkill(skillTerm);
              handed.push({ name, ...resolved });
              for (const [toolName, fn] of Object.entries(resolved.handlers)) {
                handlers[toolName] ??= (input) => provideRun(worker)(fn(input));
              }
            }
            const tools = dedupeByName([
              ...granted,
              ...handed.flatMap((skill) => [...skill.tools]),
            ]);
            const system = [
              params.instructions,
              ...handed.map(
                (skill) => `## Skill: ${skill.name}\n\n${skill.prose}`,
              ),
            ].join("\n\n");
            const toolkit = yield* buildToolkit(tools, handlers);
            yield* startLoop(worker, () =>
              Effect.succeed({ system, toolkit } as TickResult),
            );
            yield* Queue.offer(worker.inbox, params.task);
            const waiter = yield* Deferred.make<unknown>();
            worker.waiters.push(waiter);
            return yield* Deferred.await(waiter);
          });

        /**
         * One ACTOR tick: evaluate the run's turn. An Outcome settles
         * the run; a Fragment renders into this tick's SYSTEM PROMPT
         * (verbatim) and toolkit.
         */
        const actorTick = (run: RunState): Effect.Effect<TickResult> =>
          Effect.gen(function* () {
            const result = yield* provideRun(run)(
              Effect.suspend(() => {
                // each ATTEMPT starts with a clean say buffer, so a
                // retried turn delivers only the successful
                // evaluation's notes — never a failed attempt's
                run.pendingNotes.length = 0;
                return run.turn as Turn;
              }).pipe(
                // transient turn failures (an observation fetch, a
                // flaky service) retry; a typed Refused is the run
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
                `KernelMemory: the turn of '${termName}' (run '${run.key}') returned an Effect — did you forget to yield* an AI.prose?`,
              );
            }
            if (!isFragment(result)) {
              // any non-Fragment value concludes the run from inside
              return { outcome: { value: result } };
            }
            const stance = yield* renderStance(run, result);

            // the SKILL GRAPH: a stance mention is access at the root;
            // an ACTIVE skill's teaching exposes the skills it
            // references (access, one level per activation) — walk the
            // active frontier to a fixpoint so nested doctrine trees
            // resolve however deep the activations go
            const effectiveSkills = new Map(stance.skills);
            {
              const frontier = [...run.active];
              const visited = new Set<string>();
              while (frontier.length > 0) {
                const name = frontier.pop()!;
                if (visited.has(name)) continue;
                visited.add(name);
                const term = effectiveSkills.get(name);
                if (term === undefined) continue; // not reachable now
                const resolved = yield* resolveSkill(term);
                for (const sub of resolved.skills) {
                  const subName = sub["~alchemy/Name"];
                  if (!effectiveSkills.has(subName)) {
                    effectiveSkills.set(subName, sub);
                  }
                  if (run.active.has(subName)) frontier.push(subName);
                }
              }
            }
            run.lastStance = { ...stance, skills: effectiveSkills };

            // this tick's CAPABILITIES: mentioned tools + active∩reachable
            // skills' tools, with their handlers
            const capabilityHandlers: Record<
              string,
              (params: any) => Effect.Effect<any, any>
            > = {};
            const charterTools: Array<AiTool.Any> = [];
            for (const [name, compiled] of stance.tools) {
              charterTools.push(compileTool(compiled.term));
              const resolved = yield* resolveHandler(compiled);
              capabilityHandlers[name] = observedHandler(run, name, resolved);
            }
            const activeTools: Array<AiTool.Any> = [];
            for (const name of run.active) {
              const skillTerm = effectiveSkills.get(name);
              if (skillTerm === undefined) continue; // not reachable now
              const resolved = yield* resolveSkill(skillTerm);
              activeTools.push(...resolved.tools);
              for (const [toolName, fn] of Object.entries(resolved.handlers)) {
                capabilityHandlers[toolName] ??= observedHandler(
                  run,
                  toolName,
                  fn,
                );
              }
            }

            // the WIRE seam: an optional mode transforms how the
            // capabilities are PRESENTED (e.g. codemode collapses them
            // into one `eval` tool) — mention-is-presence unchanged;
            // absent, every grant is its own provider tool
            const capabilityTools = dedupeByName([
              ...charterTools,
              ...activeTools,
            ]);
            const wireMode = Context.getOption(context, WireMode);
            const wire: WirePresentation =
              Option.isSome(wireMode) && capabilityTools.length > 0
                ? yield* wireMode.value.present(
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

            // intrinsics stay DIRECT tools in every mode — they are
            // conversation control, not capabilities
            const handlers: Record<
              string,
              (params: any) => Effect.Effect<any, any>
            > = { ...wire.handlers };
            const delegates = new Map<string, Actor>();
            for (const [name, agent] of stance.delegates) {
              delegates.set(name, yield* resolveDelegate(agent));
            }
            if (delegates.size > 0) {
              // stamp the DELEGATION EDGE: the child run's `admitted`
              // observation records who dispatched it, so observers can
              // reconstruct the tree (issue desk → engineer → …)
              handlers.dispatch = (params: { agent: string; task: string }) =>
                delegates
                  .get(params.agent)!
                  .dispatch(params.task, {
                    parent: { term: termName, key: run.key },
                  })
                  .pipe(Effect.provide(RuntimeContext.phantom));
            }
            handlers.spawn = (params) => spawn(run, params);
            handlers.skill = skillSwitch(run);

            const intrinsics: Array<AiTool.Any> = [
              ...(delegates.size > 0
                ? [compileDispatch([...delegates.keys()])]
                : []),
              compileSpawn(
                [...stance.tools.keys()],
                [...effectiveSkills.keys()],
              ),
              ...(effectiveSkills.size > 0
                ? [compileSkillTool([...effectiveSkills.keys()])]
                : []),
            ];
            const toolkit = yield* buildToolkit(
              dedupeByName([...wire.tools, ...intrinsics]),
              handlers,
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

        const loop = (
          run: RunState,
          prepare: (run: RunState) => Effect.Effect<TickResult>,
        ) =>
          Effect.gen(function* () {
            let quiescent = false;
            while (true) {
              if (yield* Deferred.isDone(run.settled)) break;
              let inputs: Array<unknown> = yield* Queue.clear(run.inbox);
              if (inputs.length === 0 && quiescent) {
                // PARKED: the run's work is done until the world moves
                yield* observe(run, { type: "parked" });
                const wake = yield* Effect.raceFirst(
                  Effect.map(Queue.take(run.inbox), (input) => ({
                    settled: false as const,
                    input,
                  })),
                  Effect.map(Deferred.await(run.settled), () => ({
                    settled: true as const,
                  })),
                );
                if (wake.settled) break;
                inputs = [wake.input, ...(yield* Queue.clear(run.inbox))];
              }
              // boundary work: requested compaction applies BEFORE the
              // new inputs join the thread, so nothing fresh is lost
              applyCompaction(run);
              for (const input of inputs) {
                run.prompt = Prompt.concat(run.prompt, [asUserMessage(input)]);
                yield* observe(run, {
                  type: "input",
                  text:
                    typeof input === "string" ? input : JSON.stringify(input),
                });
              }
              // TICK: re-evaluate the stance before every sampling
              const tick = yield* prepare(run);
              if ("outcome" in tick) {
                yield* Deferred.succeed(run.settled, tick.outcome.value);
                break;
              }
              // deliver collected notes (`AI.say`): a PLAIN append, in
              // emission order — no dedupe, no memory. The author's
              // condition (`if (count === 30) yield* AI.say…`) is the
              // whole delivery policy.
              for (const note of run.pendingNotes.splice(0)) {
                const text = render(note.template as TemplateStringsArray, [
                  ...note.refs,
                ]);
                if (text.length === 0) continue;
                run.prompt = Prompt.concat(run.prompt, [noteMessage(text)]);
                yield* observe(run, {
                  type: "input",
                  text: `<note>\n${text}\n</note>`,
                });
              }
              const startedAt = yield* Effect.sync(() => Date.now());
              const response = yield* step(
                Prompt.concat(
                  Prompt.make([{ role: "system", content: tick.system }]),
                  run.prompt,
                ),
                tick.toolkit,
                (part) =>
                  part.kind === "tool-call"
                    ? observe(run, {
                        type: "tool-call",
                        tick: run.tick,
                        toolCallId: part.id,
                        toolName: part.name,
                        input: part.params,
                      })
                    : observe(run, {
                        type: "assistant-delta",
                        tick: run.tick,
                        channel: part.kind,
                        delta: part.delta,
                      }),
              );
              // where the time goes: one line per sampling (model
              // round-trip INCLUDING the tool handlers that ran
              // inside it) — the timing profile of every run
              yield* Effect.logInfo(
                `Kernel run '${run.key}' of '${termName}': sampling #${run.tick} took ${Date.now() - startedAt}ms` +
                  (response.toolCalls.length > 0
                    ? ` [${response.toolCalls.map((call) => call.name).join(", ")}]`
                    : " [quiesced]"),
              );
              yield* observe(run, {
                type: "assistant",
                tick: run.tick,
                ms: Date.now() - startedAt,
                text: response.text,
                reasoning: response.reasoningText,
                toolCalls: response.toolCalls.map((call) => ({
                  id: call.id,
                  name: call.name,
                  input: call.params,
                })),
              });
              for (const result of response.toolResults) {
                yield* observe(run, {
                  type: "tool-result",
                  toolCallId: result.id,
                  toolName: result.name,
                  output: result.result,
                  isFailure: result.isFailure,
                });
              }
              run.tick++;
              run.prompt = Prompt.concat(
                run.prompt,
                Prompt.fromResponseParts(response.content),
              );
              quiescent = response.toolCalls.length === 0;
              if (quiescent) {
                for (const waiter of run.waiters.splice(0)) {
                  yield* Deferred.succeed(waiter, response.text);
                }
              }
            }
            // settled: anyone still waiting gets the outcome
            const outcome = yield* Deferred.await(run.settled);
            yield* observe(run, { type: "settled" });
            for (const waiter of run.waiters.splice(0)) {
              yield* Deferred.succeed(waiter, outcome);
            }
          });

        /** Fork a run's loop into the interpret Scope. */
        const startLoop = (
          run: RunState,
          prepare: (run: RunState) => Effect.Effect<TickResult>,
        ) =>
          Effect.forkIn(
            loop(run, prepare).pipe(
              // a crashed loop must never strand its callers: the
              // failure exit propagates to every waiter (dispatch
              // dies with the same defect) and marks the run ended
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? Effect.gen(function* () {
                      // fire-and-forget deliveries (`send`) have no waiter
                      // to die with — the log is their only witness
                      yield* Effect.logError(
                        `Kernel run '${run.key}' of '${termName}' crashed`,
                        exit.cause,
                      );
                      yield* observe(run, {
                        type: "crashed",
                        error: String(exit.cause),
                      });
                      for (const waiter of run.waiters.splice(0)) {
                        yield* Deferred.done(waiter, exit as Exit.Exit<never>);
                      }
                      yield* Deferred.done(
                        run.settled,
                        exit as Exit.Exit<never>,
                      );
                    })
                  : Effect.void,
              ),
            ),
            scope,
          );

        /**
         * Admit one item: on first sight of a key, run the CHARTER for
         * that run (per-run init — the closure is the instance), then
         * start its loop.
         */
        const admit = (
          item: unknown,
          key?: string,
          parent?: { readonly term: string; readonly key: string },
        ) =>
          Effect.gen(function* () {
            const runKey = key ?? `run-${mintPrefix}-${minted++}`;
            let run = runs.get(runKey);
            if (run === undefined) {
              run = yield* makeRunState(runKey);
              yield* observe(run, { type: "admitted", parent });
              // per-run init: the thread exists (Thread in scope for
              // thread-scoped setup); no sampling yet (no Tick)
              const initResult = yield* provideInit(run)(
                charter as Effect.Effect<unknown, unknown>,
              ).pipe(Effect.orDie);
              run.turn = isFragment(initResult)
                ? Effect.succeed(initResult)
                : Effect.isEffect(initResult)
                  ? (initResult as Turn)
                  : yield* Effect.die(
                      `KernelMemory: the charter for '${termName}' returned neither prose nor a turn effect`,
                    );
              yield* startLoop(run, actorTick);
              runs.set(runKey, run);
            }
            lastKey = runKey;
            if (!(yield* Deferred.isDone(run.settled))) {
              yield* Queue.offer(run.inbox, item);
            }
            return run;
          });

        const actor: Actor = {
          send: (item, options) =>
            Effect.asVoid(admit(item, options?.key, options?.parent)),
          dispatch: (item, options) =>
            Effect.gen(function* () {
              const run = yield* admit(item, options?.key, options?.parent);
              if (yield* Deferred.isDone(run.settled)) {
                return yield* Deferred.await(run.settled);
              }
              const waiter = yield* Deferred.make<unknown>();
              run.waiters.push(waiter);
              return yield* Deferred.await(waiter);
            }),
          steer: ((first: unknown, second?: unknown) =>
            Effect.gen(function* () {
              const [key, input] =
                second === undefined
                  ? [lastKey, first]
                  : [first as string, second];
              if (key === undefined) return;
              const run = runs.get(key);
              if (run === undefined) {
                // crash recovery: a KEYED steer must never be silently
                // dropped — the run's state died with the isolate but
                // the world's event is real; admit a fresh run
                if (second !== undefined) {
                  yield* Effect.asVoid(admit(input, key));
                }
                return;
              }
              if (yield* Deferred.isDone(run.settled)) return;
              yield* Queue.offer(run.inbox, input);
            })) as Actor["steer"],
          settle: (runKey, event) =>
            Effect.gen(function* () {
              const run = runs.get(runKey);
              if (run === undefined) return;
              // idempotent: a second settle changes nothing
              yield* Deferred.succeed(run.settled, event);
            }),
          interrupt: () =>
            Effect.gen(function* () {
              for (const run of runs.values()) {
                yield* Deferred.succeed(run.settled, {
                  interrupted: true,
                });
              }
            }),
        };
        return actor;
      });

    return { interpret } as Context.Service.Shape<typeof Kernel> as never;
  }) as never,
);
