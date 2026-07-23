import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Prompt from "effect/unstable/ai/Prompt";
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
    success: S.Unknown,
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
 * A situation update — the kernel's own voice, delivered in the user
 * role (the only channel existing model APIs accept mid-conversation
 * environment input on) and delimited so it is never mistaken for the
 * human's words. The head's coda teaches the semantics: the latest
 * situation supersedes earlier statements on the same matters.
 */
const situationMessage = (body: string): Prompt.MessageEncoded => ({
  role: "user",
  content: [{ type: "text", text: `<situation>\n${body}\n</situation>` }],
});

/**
 * A note — the charter's EVENT channel (`AI.say`): a point-in-time
 * remark, delivered once into the current thread, never superseded and
 * never restated. Ordered after any situation of the same tick.
 */
const noteMessage = (body: string): Prompt.MessageEncoded => ({
  role: "user",
  content: [{ type: "text", text: `<note>\n${body}\n</note>` }],
});

/**
 * Delivered when the stance returns to the frozen head after a
 * situation was outstanding: restoration is a transition too, and the
 * superseding contract demands it be announced — otherwise the last
 * situation (which "supersedes instructions above") stands forever.
 */
const SITUATION_RESTORED =
  "The prior situation no longer holds; the original instructions above apply unchanged.";

/**
 * Appended once to every frozen head: how to read the kernel-authored
 * channels. The head never changes after the first tick (prompt-cache
 * discipline); everything dynamic arrives as situations and notes.
 */
const SITUATION_CODA = `

---
As work proceeds, <situation> messages may arrive describing the current state of this work — the latest situation supersedes earlier statements on the same matters, including instructions above. <note> messages are point-in-time remarks; they are never superseded.`;

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
  readonly skills: Map<string, Skill<string, any[], any>>;
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
  /** Rendered notes DELIVERED into the current thread (say dedupe). */
  readonly saidLog: Set<string>;
  /** Frozen on the first tick; never re-rendered (cache discipline). */
  head?: { readonly text: string; readonly blocks: ReadonlySet<string> };
  /** The last situation DELIVERED into the current thread ("" = head). */
  lastSituation?: string;
  /** The last rendered stance — what `spawn`/`skill` grant from. */
  lastStance?: Stance;
}

/** What one tick hands the loop. */
type TickResult =
  | { readonly outcome: { readonly value: unknown } }
  | {
      readonly system: string;
      readonly toolkit: Toolkit.WithHandler<any> | undefined;
      /** A changed situation to inject before this sampling, if any. */
      readonly inject?: string;
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
 *   result is the tick's STANCE: its blocks are diffed (first tick
 *   freezes the system prompt; later changes arrive as superseding
 *   `<situation>` messages, and returning to the head is announced);
 *   its mentions are the tick's toolkit. Any OTHER value settles the
 *   run from inside; a `Refused` failure is the run giving up.
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

        // ── the run-scoped AI.Thread / AI.Tick services ─────────────
        const makeThreadService = (run: RunState): ThreadService => ({
          key: run.key,
          tokens: Effect.sync(() =>
            Math.ceil(
              ((run.head?.text.length ?? 0) +
                JSON.stringify(run.prompt.content).length) /
                4,
            ),
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
         * context and the runtime color — deliberately NOT
         * `AI.Thread`/`AI.Tick`. Init is setup (Refs, bindings, inline
         * tools); the run is a runtime fact that only turns and tool
         * handlers may read. `CharterServices` enforces this at the
         * type level; an init that sneaks a `yield* AI.Thread` past it
         * dies here with a missing-service defect.
         */
        const provideInit = <A, E>(
          effect: Effect.Effect<A, E, any>,
        ): Effect.Effect<A, E> =>
          effect.pipe(
            Effect.provide(RuntimeContext.phantom),
            Effect.provide(context),
          ) as Effect.Effect<A, E>;

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
        }
        const skillCache = new Map<string, ResolvedSkill>();
        const resolveSkill = (skill: Skill<string, any[], any>) =>
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
            const impl = service.value as SkillService;
            const skillTools = skill.refs.filter(isTool);
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
              prose: render(skill.template, skill.refs),
              tools: skillTools.map(compileTool),
              handlers,
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
            const skills = new Map<string, Skill<string, any[], any>>();
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
        // sampling — tool handlers execute INSIDE this call. Transient
        // provider failures retry with capped backoff before dying: a
        // 429 must never poison a run key.
        const step = (
          prompt: Prompt.Prompt,
          toolkit: Toolkit.WithHandler<any> | undefined,
        ) =>
          (
            model.generateText as (
              options: unknown,
            ) => Effect.Effect<LanguageModel.GenerateTextResponse<any>, unknown>
          )({ prompt, toolkit }).pipe(
            Effect.retry({
              schedule: Schedule.exponential("1 second"),
              times: 3,
            }),
            Effect.orDie,
          );

        const runs = new Map<string, RunState>();
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
              saidLog: new Set<string>(),
            };
          });

        /**
         * Apply a requested compaction at the tick boundary. The head
         * is untouched; drops leave an archived marker (restorable
         * eviction — nothing is silently rewritten); reset restarts
         * the thread as one summary situation.
         */
        const applyCompaction = (run: RunState): void => {
          const plan = run.pendingCompaction;
          if (plan === undefined) return;
          run.pendingCompaction = undefined;
          if ("reset" in plan) {
            run.prompt = Prompt.make([
              situationMessage(
                `The thread was compacted; it restarts from this summary of prior work:\n${plan.reset.summary}`,
              ),
            ]);
            // delivery logs are THREAD-scoped: the fresh thread has
            // heard nothing, so the standing situation restates itself
            // and still-true notes re-deliver on the next tick
            run.lastSituation = undefined;
            run.saidLog.clear();
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
            const worker = yield* makeRunState(`spawn-${minted++}`);
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
         * the run; a Fragment renders into the stance, this tick's
         * toolkit, and the situation delta (including the restoration
         * announcement when the stance returns to the frozen head).
         */
        const actorTick = (run: RunState): Effect.Effect<TickResult> =>
          Effect.gen(function* () {
            const result = yield* provideRun(run)(
              (run.turn as Turn).pipe(
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
            run.lastStance = stance;

            // this tick's toolkit: mentioned tools + active∩mentioned
            // skills' tools + intrinsics
            const handlers: Record<
              string,
              (params: any) => Effect.Effect<any, any>
            > = {};
            const charterTools: Array<AiTool.Any> = [];
            for (const [name, compiled] of stance.tools) {
              charterTools.push(compileTool(compiled.term));
              const resolved = yield* resolveHandler(compiled);
              handlers[name] = (input) => provideRun(run)(resolved(input));
            }
            const activeTools: Array<AiTool.Any> = [];
            for (const name of run.active) {
              const skillTerm = stance.skills.get(name);
              if (skillTerm === undefined) continue; // not mentioned now
              const resolved = yield* resolveSkill(skillTerm);
              activeTools.push(...resolved.tools);
              for (const [toolName, fn] of Object.entries(resolved.handlers)) {
                handlers[toolName] ??= (input) => provideRun(run)(fn(input));
              }
            }
            const delegates = new Map<string, Actor>();
            for (const [name, agent] of stance.delegates) {
              delegates.set(name, yield* resolveDelegate(agent));
            }
            if (delegates.size > 0) {
              handlers.dispatch = (params: { agent: string; task: string }) =>
                delegates
                  .get(params.agent)!
                  .dispatch(params.task)
                  .pipe(Effect.provide(RuntimeContext.phantom));
            }
            handlers.spawn = (params) => spawn(run, params);
            handlers.skill = skillSwitch(run);

            const intrinsics: Array<AiTool.Any> = [
              ...(delegates.size > 0
                ? [compileDispatch([...delegates.keys()])]
                : []),
              compileSpawn([...stance.tools.keys()], [...stance.skills.keys()]),
              ...(stance.skills.size > 0
                ? [compileSkillTool([...stance.skills.keys()])]
                : []),
            ];
            const toolkit = yield* buildToolkit(
              dedupeByName([...charterTools, ...activeTools, ...intrinsics]),
              handlers,
            );

            // first tick: freeze the head (byte-stable forever after)
            if (run.head === undefined) {
              run.head = {
                text: stance.blocks.join("\n\n") + SITUATION_CODA,
                blocks: new Set(stance.blocks),
              };
              return { system: run.head.text, toolkit };
            }
            // later ticks: blocks outside the frozen head ARE the
            // situation. Deliver the full restatement when it changes —
            // INCLUDING the return to the head state, which must be
            // announced or the stale situation stands forever.
            const situation = stance.blocks
              .filter((block) => !run.head!.blocks.has(block))
              .join("\n\n");
            const last = run.lastSituation ?? "";
            if (situation !== last) {
              run.lastSituation = situation;
              return {
                system: run.head.text,
                toolkit,
                inject: situation.length > 0 ? situation : SITUATION_RESTORED,
              };
            }
            return { system: run.head.text, toolkit };
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
              }
              // TICK: re-evaluate the stance before every sampling
              const tick = yield* prepare(run);
              if ("outcome" in tick) {
                yield* Deferred.succeed(run.settled, tick.outcome.value);
                break;
              }
              if (tick.inject !== undefined) {
                run.prompt = Prompt.concat(run.prompt, [
                  situationMessage(tick.inject),
                ]);
              }
              // deliver collected notes (`AI.say`): dedupe by rendered
              // text against the CURRENT thread — situation first,
              // then notes, in emission order
              for (const note of run.pendingNotes.splice(0)) {
                const text = render(note.template as TemplateStringsArray, [
                  ...note.refs,
                ]);
                if (text.length === 0 || run.saidLog.has(text)) continue;
                run.saidLog.add(text);
                run.prompt = Prompt.concat(run.prompt, [noteMessage(text)]);
              }
              const response = yield* step(
                Prompt.concat(
                  Prompt.make([{ role: "system", content: tick.system }]),
                  run.prompt,
                ),
                tick.toolkit,
              );
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
        const admit = (item: unknown, key?: string) =>
          Effect.gen(function* () {
            const runKey = key ?? `run-${minted++}`;
            let run = runs.get(runKey);
            if (run === undefined) {
              run = yield* makeRunState(runKey);
              // init is setup, not runtime: no Thread/Tick in scope
              const initResult = yield* provideInit(
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
          send: (item, options) => Effect.asVoid(admit(item, options?.key)),
          dispatch: (item, options) =>
            Effect.gen(function* () {
              const run = yield* admit(item, options?.key);
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
