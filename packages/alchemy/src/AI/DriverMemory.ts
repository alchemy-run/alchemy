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
import { isAiError, type AiError } from "effect/unstable/ai/AiError";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Prompt from "effect/unstable/ai/Prompt";
import * as Response from "effect/unstable/ai/Response";
import * as AiTool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import { makeProcessScope, runOnHost } from "../Local/Process.ts";
import * as PersistentRef from "../PersistentRef.ts";
import { RuntimeContext } from "../RuntimeContext.ts";
import type { Actor } from "./Actor.ts";
import { isAgent, type Agent } from "./Agent.ts";
import { Refused } from "./Errors.ts";
import { isEvent } from "./Event.ts";
import {
  Driver,
  type Charter,
  type TurnFn,
  type Interpretable,
  type Turn,
} from "./Driver.ts";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { RunObserver, type RunObservation } from "./Observer.ts";
import { RunJournal } from "./RunJournal.ts";
import {
  AgentGateway,
  handleRunSocketFrame,
  isLiveObservation,
  type RunSocketClientFrame,
  type RunSocketServerFrame,
} from "./RunSocket.ts";
import { isParameter } from "./Parameter.ts";
import { dedentTemplate, isFragment, type Fragment } from "./Prose.ts";
import { isDispatchTool, type DispatchTool } from "./Dispatch.ts";
import { isSkill, type Skill, type SkillService } from "./Skill.ts";
import {
  asUserMessage,
  buildToolkit,
  compileDispatch,
  compileSkillTool,
  compileSpawn,
  compileTool,
  type CompiledToolRef,
  dedupeByName,
  describeCrash,
  inputProvenance,
  noteMessage,
  NOTE_CODA,
  reminderInput,
  render,
  type Stance,
} from "./DriverShared.ts";
import { makeSampler, Sampler } from "./Sampler.ts";
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
 * One mailbox delivery: the input plus, for a `dispatch`, the waiter
 * that rides it. Pairing them is what makes replies HONEST: a waiter
 * only becomes answerable once its input has been drained into a
 * round — a dispatch that arrives while an earlier round's epilogue
 * is still sampling can never be resolved by that round's quiescence.
 */
interface InboxItem {
  readonly input: unknown;
  readonly waiter?: Deferred.Deferred<unknown>;
}

interface RunState {
  readonly inbox: Queue.Queue<InboxItem>;
  /**
   * QUIET inputs (`send(…, { wake: false })`): delivered into the
   * thread at the next sampling boundary, but never a wake themselves
   * — a parked run stays parked with these accumulating as context.
   */
  readonly quiet: Array<InboxItem>;
  /** The CURRENT round's waiters — resolved by `AI.reply` or, for
   *  rounds that never reply, by quiescence with the response text. */
  readonly waiters: Array<Deferred.Deferred<unknown>>;
  /** The run's ending: `settle` from outside, or a turn Outcome. */
  readonly settled: Deferred.Deferred<unknown>;
  /** World identity (`owner/repo#7`) or driver-minted. */
  readonly key: string;
  /** Skills this run has activated (effective when also mentioned). */
  readonly active: Set<string>;
  /** Samplings performed so far. */
  tick: number;
  /** The thread — everything after the (separate) frozen head. */
  prompt: Prompt.Prompt;
  /** The run's TURN, produced by its own charter init — a constant
   *  fragment lifted to an Effect, or a function of the tick event. */
  turn?: Turn | TurnFn;
  /** Requested compaction; applied at the next tick's start. */
  pendingCompaction?: CompactPlan;
  /** Notes collected via `AI.say`, awaiting delivery this tick. */
  readonly pendingNotes: Array<Fragment>;
  /** Next observation sequence number (the observer's cursor). */
  observed: number;
  /** The DURABLE observation log — this run's own projection, what a
   *  socket's `subscribe {fromSeq}` replays (ring-buffered). */
  readonly log: Array<RunObservation>;
  /** Attached run sockets — each entry sends one wire frame. */
  readonly sockets: Set<(frame: RunSocketServerFrame) => Effect.Effect<void>>;
  /** The last rendered stance — what `spawn`/`skill` grant from. */
  lastStance?: Stance;
  /**
   * Session workers this run dispatched — the SUPERVISION edge: when
   * this run settles, its children settle with it. Keyed by
   * `{agent}:{childKey}` because two DIFFERENT agents may share one
   * child key (a shared-workspace topology: the engineer and the
   * reviewer both keyed by the issue); the value carries the run key
   * the cascade settles.
   */
  readonly children: Map<
    string,
    { readonly key: string; readonly actor: Actor }
  >;
  /**
   * The run's `PersistentRef.Store` — on this in-memory driver a
   * plain Map, exactly as durable as the run itself (the substrate's
   * durability IS its lifetime). The durable driver implements the
   * same contract over DO storage.
   */
  readonly stateStore: PersistentRef.StoreService;
}

/** What one tick hands the loop. */
interface TickResult {
  readonly system: string;
  readonly toolkit: Toolkit.WithHandler<any> | undefined;
}

/**
 * The in-memory Driver: the smallest interpreter that makes a charter
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
 *   notes, tool results, and steers. Answering a caller is the
 *   explicit `AI.reply` act (a tool handler, usually); a `Refused`
 *   failure is the run giving up.
 * - `AI.Run` is provided to init, turn, and tool handlers: driver
 *   facts (key, tick, tokens) plus read-only thread access and the one
 *   thread mutation — `compact`, applied at tick boundaries only.
 *
 * ```
 * loop: drain mailbox → apply pending compaction → user messages
 *       TICK: evaluate turn (fn turns receive {count, inputs}) →
 *             render stance → toolkit
 *       streamText(head + thread, toolkit)     (tools run inside;
 *                                               AI.reply answers waiters)
 *       append response parts
 *       tool calls?  → loop                    (the agentic loop)
 *       quiescent    → resolve REMAINING waiters with the text,
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
export const DriverMemory: Layer.Layer<
  Driver | AgentGateway,
  never,
  LanguageModel.LanguageModel
> = Layer.effectContext(
  Effect.gen(function* () {
    /** term → the socket door its `interpret` registered. */
    const socketHosts = new Map<
      string,
      {
        readonly ensure: (key: string) => Effect.Effect<RunState>;
        readonly submit: (key: string, input: unknown) => Effect.Effect<void>;
      }
    >();
    const model = yield* LanguageModel.LanguageModel;
    // Process-lifetime forks (run loops, remind, sockets): under a
    // Platform Host these survive `Effect.provide` of OrgLocal; in
    // unit tests they ride the ambient Scope wrapping the test body.
    const process = yield* makeProcessScope;

    const interpret = (term: Interpretable, charter: Charter) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<never>();
        const termName = term["~alchemy/Name"];

        // the observability seam (same pattern as WireMode): when an
        // observer is present, run lifecycle facts flow into it —
        // fire-and-forget, an observer can never fail or slow a run.
        // Each run's observations carry a monotonic `seq`, the
        // catch-up cursor consumers dedupe and resume by.
        const observer = Context.getOption(context, RunObserver);
        // the durability seams (both optional — see RunJournal.ts):
        // an ambient PersistentRef.Store makes charter refs durable
        // (the run frame isolates keys); a RunJournal makes THREADS
        // durable — saved at park/crash, removed at settle, restored
        // parked at interpret.
        const ambientStore = Context.getOption(context, PersistentRef.Store);
        const journal = Context.getOption(context, RunJournal);
        // the SAMPLER seam (driver-assembly.md §3): a user driver
        // provides its own (retry/budget/tiering policy lives inside
        // it); absent, the default over this driver's LanguageModel.
        const sampler = Option.getOrElse(
          Context.getOption(context, Sampler),
          () => makeSampler(model),
        );
        const saveSnapshot = (run: RunState): Effect.Effect<void> =>
          Option.isNone(journal)
            ? Effect.void
            : Effect.suspend(() =>
                journal.value.save({
                  term: termName,
                  key: run.key,
                  tick: run.tick,
                  observed: run.observed,
                  active: [...run.active],
                  prompt: S.encodeSync(Prompt.Prompt)(run.prompt),
                  log: [...run.log],
                }),
              ).pipe(
                // persistence must never crash or slow a run — a
                // failed save costs restart fidelity, not the round
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    `RunJournal save failed for '${run.key}' of '${termName}'`,
                    cause,
                  ),
                ),
              );
        const observe = (
          run: RunState,
          observation: DistributiveOmit<
            RunObservation,
            "term" | "key" | "seq" | "at"
          >,
        ): Effect.Effect<void> =>
          Effect.gen(function* () {
            // live facts (deltas, in-flight tool calls) never log and
            // never advance the cursor — same split as the CF driver
            const live = isLiveObservation(observation.type);
            const full = {
              ...observation,
              term: termName,
              key: run.key,
              seq: live ? run.observed : run.observed++,
              at: Date.now(),
            } as RunObservation;
            if (!live) {
              run.log.push(full);
              // ring: mirror ChatsMemory's eviction policy
              if (run.log.length > 2000) run.log.splice(0, 500);
            }
            if (run.sockets.size > 0) {
              const frame: RunSocketServerFrame = {
                type: "observation",
                durable: !live,
                observation: full,
              };
              for (const send of run.sockets) {
                yield* Effect.ignore(send(frame));
              }
            }
            if (Option.isSome(observer)) {
              yield* observer.value.emit(full).pipe(Effect.ignore);
            }
          });

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
          // ANSWER the current round, from wherever the answer is
          // produced (usually a tool handler) — the caller resolves
          // now; the run neither parks nor ends
          reply: (value) =>
            Effect.gen(function* () {
              for (const waiter of run.waiters.splice(0)) {
                yield* Deferred.succeed(waiter, value);
              }
            }),
          // the driver's CLOCK, fused to the run's lifetime: on this
          // in-memory driver runs live as long as the process, so a
          // process-scoped fiber is exactly as durable as the run —
          // a DO-backed driver implements the same contract with an
          // alarm. Delivery is an ordinary inbox message: a wake if
          // parked, queued if busy, dropped if settled.
          remind: (delay, note) =>
            process.fork(
              Effect.sleep(delay).pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    if (yield* Deferred.isDone(run.settled)) return;
                    yield* Queue.offer(run.inbox, {
                      input: reminderInput(note),
                    });
                  }),
                ),
                Effect.asVoid,
              ),
            ),
        });

        const makeTickService = (run: RunState): TickService => ({
          count: run.tick,
          say: (note) =>
            Effect.sync(() => {
              run.pendingNotes.push(note);
            }),
        });

        /**
         * Provide the driver-owned services to RUNTIME charter code
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
              Effect.provideService(PersistentRef.Store, run.stateStore),
              // the FRAME: refs are namespaced by the run's identity
              PersistentRef.within(termName, run.key),
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
              Effect.provideService(PersistentRef.Store, run.stateStore),
              // the FRAME: refs are namespaced by the run's identity
              PersistentRef.within(termName, run.key),
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
                  `Driver run '${run.key}' of '${termName}': tool '${name}' failed: ${String(error).slice(0, 500)}`,
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
                `DriverMemory: no implementation provided for tool '${name}' of '${termName}' — provide the tool's Layer or splice an inline impl`,
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
                `DriverMemory: no implementation provided for skill '${skillName}' referenced by '${termName}'`,
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
                  `DriverMemory: skill '${skillName}' implementation provides no tool '${name}'`,
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
                `DriverMemory: no implementation provided for agent '${name}' referenced by '${termName}'`,
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

        const runs = new Map<string, RunState>();
        // Minted keys are PROCESS-UNIQUE, not just driver-unique: run
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
              inbox: yield* Queue.unbounded<InboxItem>(),
              quiet: [],
              waiters: [],
              settled: yield* Deferred.make<unknown>(),
              key,
              active: new Set<string>(),
              tick: 0,
              prompt: Prompt.empty,
              pendingNotes: [],
              observed: 0,
              log: [],
              sockets: new Set(),
              children: new Map(),
              // an ambient store (org-provided sqlite, DO storage)
              // makes charter refs durable; the run frame
              // (within(term, key)) keeps per-run isolation on the
              // shared store. Absent: exactly as durable as the run.
              stateStore: Option.isSome(ambientStore)
                ? ambientStore.value
                : PersistentRef.makeMemoryStore(),
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
            yield* Queue.offer(worker.inbox, { input: params.task });
            const waiter = yield* Deferred.make<unknown>();
            worker.waiters.push(waiter);
            return yield* Deferred.await(waiter);
          });

        /**
         * One ACTOR tick: evaluate the run's turn — a function turn
         * receives the tick event ({count, inputs}) — and render the
         * resulting Fragment into this tick's SYSTEM PROMPT (verbatim)
         * and toolkit. The turn returns the STANCE and nothing else:
         * answering a caller is `AI.reply` (from a tool handler or
         * turn code), never a return value.
         */
        const actorTick = (
          run: RunState,
          inputs: ReadonlyArray<unknown>,
        ): Effect.Effect<TickResult> =>
          Effect.gen(function* () {
            const result = yield* provideRun(run)(
              Effect.suspend(() => {
                // each ATTEMPT starts with a clean say buffer, so a
                // retried turn delivers only the successful
                // evaluation's notes — never a failed attempt's
                run.pendingNotes.length = 0;
                const turn = run.turn!;
                return typeof turn === "function"
                  ? turn({ count: run.tick, inputs })
                  : turn;
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
                `DriverMemory: the turn of '${termName}' (run '${run.key}') returned an Effect — did you forget to yield* an AI.prose?`,
              );
            }
            if (!isFragment(result)) {
              return yield* Effect.die(
                `DriverMemory: the turn of '${termName}' (run '${run.key}') returned a non-Fragment value — turns return the stance; answer callers with AI.reply`,
              );
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
                  const derived = yield* door.policy(params, {
                    key: run.key,
                  });
                  const actor = yield* resolveDelegate(door.agent);
                  const agentName = door.agent["~alchemy/Name"];
                  if (derived.key !== undefined) {
                    run.children.set(`${agentName}:${derived.key}`, {
                      key: derived.key,
                      actor,
                    });
                  }
                  yield* observe(run, {
                    type: "dispatched",
                    tick: run.tick,
                    toolName: name,
                    agent: agentName,
                    child: derived.key,
                  });
                  return yield* actor
                    .dispatch(derived.task, {
                      key: derived.key,
                      parent: { term: termName, key: run.key },
                    })
                    .pipe(Effect.provide(RuntimeContext.phantom));
                });
              capabilityHandlers[name] = observedHandler(
                run,
                name,
                doorHandler,
              );
            }

            // the WIRE seam: an optional mode transforms how the
            // capabilities are PRESENTED (e.g. codemode collapses them
            // into one `eval` tool) — mention-is-presence unchanged;
            // absent, every grant is its own provider tool
            const capabilityTools = dedupeByName([
              ...charterTools,
              ...activeTools,
              ...doorTools,
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
              // reconstruct the tree (issue desk → engineer → …). A
              // `session` derives a DETERMINISTIC child key namespaced
              // under this run — the call/reply seam: same session,
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
                      : `${run.key}/${params.agent}/${params.session}`;
                  if (key !== undefined) {
                    run.children.set(`${params.agent}:${key}`, { key, actor });
                  }
                  yield* observe(run, {
                    type: "dispatched",
                    tick: run.tick,
                    toolName: "dispatch",
                    agent: params.agent,
                    child: key,
                  });
                  return yield* actor
                    .dispatch(params.task, {
                      key,
                      parent: { term: termName, key: run.key },
                    })
                    .pipe(Effect.provide(RuntimeContext.phantom));
                });
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
          prepare: (
            run: RunState,
            inputs: ReadonlyArray<unknown>,
          ) => Effect.Effect<TickResult>,
        ) =>
          Effect.gen(function* () {
            // starts QUIESCENT: a run created without input (a socket
            // attach `ensure`s it; the admitting offer may lose the
            // startup race) parks on the queue instead of sampling an
            // empty thread
            let quiescent = true;
            // consecutive malformed-tool-call feedback rounds (see the
            // step catch below) — resets on any well-formed sampling
            let malformed = 0;
            while (true) {
              if (yield* Deferred.isDone(run.settled)) break;
              let items: Array<InboxItem> = yield* Queue.clear(run.inbox);
              if (items.length === 0 && quiescent) {
                // PARKED: the run's work is done until the world moves.
                // Quiet inputs deliberately DON'T factor in — they
                // accumulate as context and never wake a parked run.
                yield* observe(run, { type: "parked" });
                // the durability point of the restart surface: a
                // parked thread survives the process. Saved AFTER the
                // parked observation so the snapshot's seq cursor
                // includes it — a restored run must never re-issue an
                // already-used seq (consumers dedupe by seq).
                yield* saveSnapshot(run);
                const wake = yield* Effect.raceFirst(
                  Effect.map(Queue.take(run.inbox), (item) => ({
                    settled: false as const,
                    item,
                  })),
                  Effect.map(Deferred.await(run.settled), () => ({
                    settled: true as const,
                  })),
                );
                if (wake.settled) break;
                items = [wake.item, ...(yield* Queue.clear(run.inbox))];
              }
              // quiet inputs JOIN whatever round is happening anyway —
              // prepended (they arrived earlier), never a wake themselves
              items = [...run.quiet.splice(0), ...items];
              // boundary work: requested compaction applies BEFORE the
              // new inputs join the thread, so nothing fresh is lost
              applyCompaction(run);
              // drained waiters JOIN THE ROUND: only now are they
              // answerable — by AI.reply, or by quiescence as fallback
              const drained: Array<{
                readonly value: unknown;
                readonly kind?: "reminder";
              }> = [];
              for (const item of items) {
                drained.push(inputProvenance(item.input));
                if (item.waiter !== undefined) run.waiters.push(item.waiter);
              }
              const inputs = drained.map((item) => item.value);
              for (const { value, kind } of drained) {
                run.prompt = Prompt.concat(run.prompt, [asUserMessage(value)]);
                yield* observe(run, {
                  type: "input",
                  text:
                    typeof value === "string" ? value : JSON.stringify(value),
                  kind,
                });
              }
              // TICK: re-evaluate the stance before every sampling —
              // function turns receive the tick event ({count, inputs})
              const tick = yield* prepare(run, inputs);
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
                  kind: "note",
                });
              }
              const startedAt = yield* Effect.sync(() => Date.now());
              const response = yield* sampler
                .step({
                  prompt: Prompt.concat(
                    Prompt.make([{ role: "system", content: tick.system }]),
                    run.prompt,
                  ),
                  toolkit: tick.toolkit,
                  onLive: (part) =>
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
                })
                .pipe(
                  // A MALFORMED TOOL CALL is a model-visible fact, not a
                  // crash: nothing was executed, so tell the model what
                  // was wrong and let it re-issue. Bounded — a model that
                  // keeps emitting invalid calls crashes with the real
                  // error after the sampler's streak budget.
                  Effect.catchIf(
                    (error): error is AiError =>
                      isAiError(error) &&
                      error.reason._tag === "ToolParameterValidationError",
                    (error) =>
                      malformed >= sampler.malformedBudget
                        ? Effect.fail(error)
                        : Effect.succeed({
                            malformed: error.message,
                          } as const),
                  ),
                );
              if ("malformed" in response) {
                malformed++;
                const text =
                  `your last response included a tool call with INVALID ` +
                  `parameters — NOTHING was executed:\n${response.malformed}\n` +
                  `Re-issue the call with parameters matching the tool's schema.`;
                run.prompt = Prompt.concat(run.prompt, [noteMessage(text)]);
                yield* observe(run, {
                  type: "input",
                  text: `<note>\n${text}\n</note>`,
                  kind: "note",
                });
                quiescent = false; // come straight back around and re-sample
                continue;
              }
              malformed = 0;
              // where the time goes: one line per sampling (model
              // round-trip INCLUDING the tool handlers that ran
              // inside it) — the timing profile of every run
              yield* Effect.logInfo(
                `Driver run '${run.key}' of '${termName}': sampling #${run.tick} took ${Date.now() - startedAt}ms` +
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
            // settled: anyone still waiting gets the outcome — the
            // current round's waiters AND undrained arrivals alike
            const outcome = yield* Deferred.await(run.settled);
            yield* observe(run, { type: "settled" });
            // settled runs are never restored — drop the journal row
            if (Option.isSome(journal)) {
              yield* journal.value
                .remove(termName, run.key)
                .pipe(Effect.ignore);
            }
            for (const item of yield* Queue.clear(run.inbox)) {
              if (item.waiter !== undefined) run.waiters.push(item.waiter);
            }
            for (const waiter of run.waiters.splice(0)) {
              yield* Deferred.succeed(waiter, outcome);
            }
            yield* settleChildren(run);
          });

        /**
         * The SUPERVISION cascade: a settled (or crashed) run settles
         * every session worker it dispatched — parked workers must not
         * outlive the conversation that owns them.
         */
        const settleChildren = (run: RunState): Effect.Effect<void> =>
          Effect.forEach(
            [...run.children.values()],
            ({ key, actor }) =>
              actor
                .settle(key, {
                  supervisor: { term: termName, key: run.key },
                })
                .pipe(Effect.provide(RuntimeContext.phantom)),
            { discard: true },
          ).pipe(Effect.andThen(Effect.sync(() => run.children.clear())));

        /** Fork a run's loop onto the process Scope. */
        const startLoop = (
          run: RunState,
          prepare: (
            run: RunState,
            inputs: ReadonlyArray<unknown>,
          ) => Effect.Effect<TickResult>,
        ) =>
          process.fork(
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
                        `Driver run '${run.key}' of '${termName}' crashed`,
                        exit.cause,
                      );
                      const crash = describeCrash(exit.cause);
                      yield* observe(run, {
                        type: "crashed",
                        error: crash.encoded,
                        fatal: !crash.encoded.retryable,
                      });
                      // crashed threads restore parked — the crash
                      // note is in the log; the next input resumes
                      yield* saveSnapshot(run);
                      for (const waiter of run.waiters.splice(0)) {
                        yield* Deferred.done(waiter, exit as Exit.Exit<never>);
                      }
                      yield* Deferred.done(
                        run.settled,
                        exit as Exit.Exit<never>,
                      );
                      // a crashed supervisor takes its session workers
                      // down with it, same as a settled one
                      yield* settleChildren(run);
                    })
                  : Effect.void,
              ),
              // the typed failure has been DELIVERED (waiters, settled,
              // observation) — the fiber itself dies as before, keeping
              // the process supervisor's crashed-loop semantics
              Effect.orDie,
              Effect.asVoid,
            ),
          );

        /**
         * Admit one item: on first sight of a key, run the CHARTER for
         * that run (per-run init — the closure is the instance), then
         * start its loop.
         */
        /** Create-or-get a run WITHOUT admitting input — the run's
         *  init and loop start; the inbox stays untouched. This is
         *  what a socket ATTACH uses: observing a run must not feed
         *  it. */
        const ensure = (
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
                  : typeof initResult === "function"
                    ? (initResult as TurnFn)
                    : yield* Effect.die(
                        `DriverMemory: the charter for '${termName}' returned neither prose, a turn effect, nor a turn function`,
                      );
              yield* startLoop(run, actorTick);
              runs.set(runKey, run);
            }
            lastKey = runKey;
            return run;
          });

        const admit = (
          item: InboxItem,
          key?: string,
          parent?: { readonly term: string; readonly key: string },
          wake = true,
        ) =>
          Effect.gen(function* () {
            const run = yield* ensure(key, parent);
            if (!(yield* Deferred.isDone(run.settled))) {
              if (wake) {
                yield* Queue.offer(run.inbox, item);
              } else {
                run.quiet.push(item);
              }
            }
            return run;
          });

        const actor: Actor = {
          send: (item, options) =>
            Effect.asVoid(
              admit(
                { input: item },
                options?.key,
                options?.parent,
                options?.wake,
              ),
            ),
          dispatch: (item, options) =>
            Effect.gen(function* () {
              // the waiter RIDES the input: it joins the answerable
              // round only when its own message is drained, so an
              // in-flight earlier round can never answer it
              const waiter = yield* Deferred.make<unknown>();
              const run = yield* admit(
                { input: item, waiter },
                options?.key,
                options?.parent,
              );
              if (yield* Deferred.isDone(run.settled)) {
                return yield* Deferred.await(run.settled);
              }
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
                  yield* Effect.asVoid(admit({ input }, key));
                }
                return;
              }
              if (yield* Deferred.isDone(run.settled)) return;
              yield* Queue.offer(run.inbox, { input });
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
        // the socket door: what `AgentGateway.attach` resolves a term
        // to — ensure (never feeds the run) plus the submit sink
        socketHosts.set(termName, {
          ensure: (key: string) => ensure(key),
          submit: (key: string, input: unknown) =>
            Effect.asVoid(admit({ input }, key)),
        });
        // ── RESTORE (bootstrap §3): persisted runs come back PARKED,
        // threads primed, seq cursor continued. Init re-runs — the
        // charter closure is the instance, rebuilt from CURRENT code
        // (level-triggered: the next tick renders the new stance).
        // No `admitted` observation: the projection already has the
        // run's history; restored runs emit nothing until they wake.
        if (Option.isSome(journal)) {
          const snapshots = yield* journal.value
            .restore(termName)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.as(
                  Effect.logWarning(
                    `RunJournal restore failed for '${termName}'`,
                    cause,
                  ),
                  [],
                ),
              ),
            );
          if (snapshots.length > 0) {
            yield* Effect.logInfo(
              `Driver '${termName}': restoring ${snapshots.length} run(s) from the journal`,
            );
          }
          for (const snapshot of snapshots) {
            if (runs.has(snapshot.key)) continue;
            const restored = yield* Effect.try({
              try: () => ({
                prompt: S.decodeUnknownSync(Prompt.Prompt)(snapshot.prompt),
              }),
              catch: (error) => error,
            }).pipe(
              Effect.tapCause((cause) =>
                Effect.logWarning(
                  `RunJournal: snapshot for '${snapshot.key}' of '${termName}' failed to decode — starting without it`,
                  cause,
                ),
              ),
              Effect.option,
            );
            if (Option.isNone(restored)) continue;
            const run = yield* makeRunState(snapshot.key);
            run.tick = snapshot.tick;
            run.observed = snapshot.observed;
            run.prompt = restored.value.prompt;
            for (const skill of snapshot.active) run.active.add(skill);
            run.log.push(...snapshot.log);
            const initResult = yield* provideInit(run)(
              charter as Effect.Effect<unknown, unknown>,
            ).pipe(Effect.orDie);
            run.turn = isFragment(initResult)
              ? Effect.succeed(initResult)
              : Effect.isEffect(initResult)
                ? (initResult as Turn)
                : typeof initResult === "function"
                  ? (initResult as TurnFn)
                  : yield* Effect.die(
                      `DriverMemory: the charter for '${termName}' returned neither prose, a turn effect, nor a turn function`,
                    );
            // The run is REGISTERED synchronously (admits/ensures find
            // its inbox and queue into it), but the loop start must
            // not block the BUILD: `startLoop` awaits the Host
            // program starting, which a plan-time build never does.
            // `runOnHost` registers it as a program runner — a
            // planner registers-and-discards (no restore in a
            // planner, no hang); the real runtime starts the loop the
            // moment `exports.program` runs, draining anything the
            // inbox queued meanwhile.
            yield* runOnHost(startLoop(run, actorTick)).pipe(
              Effect.asVoid,
            ) as Effect.Effect<void>;
            runs.set(snapshot.key, run);
            yield* Effect.logInfo(
              `Driver '${termName}': restored run '${snapshot.key}' parked at tick ${snapshot.tick}`,
            );
          }
        }
        return actor;
      });

    /**
     * The local {@link AgentGateway}: the SAME protocol the Cloudflare
     * driver speaks from its Durable Objects, served in-process — a
     * WebSocket upgrade on the host's own HTTP server, replay from
     * the run's in-memory log, live broadcast from `observe`.
     */
    // socket-serving fibers live on the process Scope — never on the
    // HTTP request that carried the upgrade: Bun counts an unresolved
    // upgraded request as in-flight, and the server's graceful stop
    // would wait its whole 20s budget on it
    const attach = (
      term: string,
      key: string,
      request: HttpServerRequest.HttpServerRequest,
    ): Effect.Effect<HttpServerResponse.HttpServerResponse, never, never> =>
      Effect.gen(function* () {
        const host = socketHosts.get(term);
        if (host === undefined) {
          return yield* Effect.die(
            `DriverMemory: no interpreted term '${term}' to attach to — has its Layer been built?`,
          );
        }
        const run = yield* host.ensure(key);
        const socket = yield* request.upgrade.pipe(Effect.orDie);
        const serve = Effect.gen(function* () {
          const write = yield* socket.writer;
          const send = (frame: RunSocketServerFrame): Effect.Effect<void> =>
            Effect.asVoid(
              Effect.ignore(write(JSON.stringify(frame))),
            ) as Effect.Effect<void>;
          const handle = handleRunSocketFrame(
            {
              replay: (fromSeq) =>
                Effect.sync(() =>
                  run.log.filter((observation) => observation.seq >= fromSeq),
                ),
              watermark: Effect.sync(() => run.observed),
              submit: (input) => host.submit(key, input),
            },
            send,
          );
          run.sockets.add(send);
          yield* socket
            .runString((raw: string) =>
              handle(JSON.parse(raw) as RunSocketClientFrame).pipe(
                Effect.catchDefect((defect) =>
                  Effect.logWarning(`[run-socket] bad frame: ${defect}`),
                ),
              ),
            )
            .pipe(
              Effect.ignore,
              Effect.ensuring(Effect.sync(() => run.sockets.delete(send))),
            );
        });
        yield* process.fork(Effect.scoped(serve).pipe(Effect.asVoid));
        return HttpServerResponse.empty();
      });

    return Context.add(
      Context.make(Driver, {
        interpret,
      } as Context.Service.Shape<typeof Driver>),
      AgentGateway,
      { attach },
    );
  }) as never,
);
