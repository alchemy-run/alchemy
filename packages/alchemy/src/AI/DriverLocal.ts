import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Prompt from "effect/unstable/ai/Prompt";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { makeProcessScope, runOnHost } from "../Local/Process.ts";
import * as PersistentRef from "../PersistentRef.ts";
import { RuntimeContext } from "../RuntimeContext.ts";
import type { Actor } from "./Actor.ts";
import {
  Driver,
  type Charter,
  type TurnFn,
  type Interpretable,
  type Turn,
} from "./Driver.ts";
import {
  applyCompactionPlan,
  asUserMessage,
  buildToolkit,
  compileTick,
  compileTool,
  dedupeByName,
  describeCrash,
  inputProvenance,
  makeResolvers,
  noteMessage,
  reminderInput,
  render,
  sampleTick,
  type ResolvedSkill,
  type SessionOps,
  type SpawnParams,
  type Stance,
  type TickResult,
} from "./DriverCore.ts";
import { makeModel, Model } from "./Model.ts";
import { SessionObserver, type SessionObservation } from "./Observer.ts";
import { isFragment, type Fragment } from "./Prose.ts";
import {
  AgentGateway,
  handleSessionSocketFrame,
  isLiveObservation,
  type SessionSocketClientFrame,
  type SessionSocketServerFrame,
} from "./SessionSocket.ts";
import type * as AiTool from "effect/unstable/ai/Tool";
import {
  Thread,
  Tick,
  type CompactPlan,
  type ThreadService,
  type TickService,
} from "./Thread.ts";
import {
  ThreadStorage,
  type ThreadHandle,
  type SessionMeta,
} from "./ThreadStorage.ts";

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

interface SessionState {
  readonly inbox: Queue.Queue<InboxItem>;
  /**
   * QUIET inputs (`send(…, { wake: false })`): delivered into the
   * thread at the next sampling boundary, but never a wake themselves
   * — a parked session stays parked with these accumulating as context.
   */
  readonly quiet: Array<InboxItem>;
  /** The CURRENT round's waiters — resolved by `AI.reply` or, for
   *  rounds that never reply, by quiescence with the response text. */
  readonly waiters: Array<Deferred.Deferred<unknown>>;
  /** The session's ending: `settle` from outside, or a turn Outcome. */
  readonly settled: Deferred.Deferred<unknown>;
  /** World identity (`owner/repo#7`) or driver-minted. */
  readonly key: string;
  /** The session's storage — thread, observation log, meta all live
   *  behind this handle (the `ThreadStorage` seam decides the
   *  substrate). */
  readonly handle: ThreadHandle;
  /** Skills this session has activated (effective when also mentioned). */
  readonly active: Set<string>;
  /** Samplings performed so far. */
  tick: number;
  /** The session's TURN, produced by its own charter init — a constant
   *  fragment lifted to an Effect, or a function of the tick event. */
  turn?: Turn | TurnFn;
  /** Requested compaction; applied at the next tick's start. */
  pendingCompaction?: CompactPlan;
  /** Notes collected via `AI.say`, awaiting delivery this tick. */
  readonly pendingNotes: Array<Fragment>;
  /** Next observation sequence number (the observer's cursor). */
  observed: number;
  /** Attached session sockets — each entry sends one wire frame. */
  readonly sockets: Set<
    (frame: SessionSocketServerFrame) => Effect.Effect<void>
  >;
  /** The last rendered stance — what `spawn`/`skill` grant from. */
  lastStance?: Stance;
  /**
   * Session workers this session dispatched — the SUPERVISION edge:
   * when this session settles, its children settle with it. Keyed by
   * `{agent}:{childKey}` because two DIFFERENT agents may share one
   * child key (a shared-workspace topology: the engineer and the
   * reviewer both keyed by the issue); the value carries the session
   * key the cascade settles.
   */
  readonly children: Map<
    string,
    { readonly key: string; readonly actor: Actor }
  >;
  /**
   * The session's `PersistentRef.Store` — absent an ambient store, a
   * plain Map exactly as durable as the process. Swap the store Layer
   * (sqlite locally, DO storage in the cloud) for durable refs.
   */
  readonly stateStore: PersistentRef.StoreService;
}

/**
 * THE driver — the shared interpreter that makes a charter LIVE. The
 * ALGORITHM (turn evaluation, stance rendering, the skill graph,
 * toolkit assembly, sampling) lives in `DriverCore` and is written
 * once; this Layer contributes the RESIDENT HOST — a forked fiber per
 * session that parks on its inbox — and consumes two seams:
 *
 * - {@link ThreadStorage} — where a session's durable facts live
 *   (thread, observation log, meta). `MemoryThreadStorage` for
 *   ephemeral sessions, `SqliteThreadStorage` for a durable local
 *   process; the Durable Object host carries its own.
 * - {@link Model} — one model call (streaming, retry policy,
 *   malformed budget). Defaults over the ambient `LanguageModel`.
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
 * admits a fresh session (crash recovery: re-polled events must never
 * be silently dropped). `settle` ends a session idempotently from the
 * outside; a settled session ignores further input and answers late
 * dispatches with its outcome.
 *
 * Durability is WRITE-THROUGH: every input, note, and response row
 * lands in the session's {@link ThreadHandle} the moment it exists,
 * and every durable observation persists its meta with it. Restore at
 * interpret brings persisted sessions back PARKED — threads primed,
 * seq cursor continued — while the BEHAVIOR (charter code, tools)
 * rebuilds from current code.
 */
export const DriverLocal: Layer.Layer<
  Driver | AgentGateway,
  never,
  LanguageModel.LanguageModel | ThreadStorage
> = Layer.effectContext(
  Effect.gen(function* () {
    /** term → the socket door its `interpret` registered. */
    const socketHosts = new Map<
      string,
      {
        readonly ensure: (key: string) => Effect.Effect<SessionState>;
        readonly submit: (key: string, input: unknown) => Effect.Effect<void>;
      }
    >();
    const languageModel = yield* LanguageModel.LanguageModel;
    const threadStorage = yield* ThreadStorage;
    // Process-lifetime forks (session loops, remind, sockets): under a
    // Platform Host these survive `Effect.provide` of the org layer;
    // in unit tests they ride the ambient Scope wrapping the test
    // body.
    const process = yield* makeProcessScope;

    const interpret = (term: Interpretable, charter: Charter) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<never>();
        const termName = term["~alchemy/Name"];

        // the observability seam (same pattern as ToolCalling): when an
        // observer is present, session lifecycle facts flow into it —
        // fire-and-forget, an observer can never fail or slow a session.
        // Each session's observations carry a monotonic `seq`, the
        // catch-up cursor consumers dedupe and resume by.
        const observer = Context.getOption(context, SessionObserver);
        // an ambient PersistentRef.Store makes charter refs durable
        // (the session frame isolates keys)
        const ambientStore = Context.getOption(context, PersistentRef.Store);
        // the MODEL seam: a user driver provides its own (retry,
        // budget, and tiering policy live inside it); absent, the
        // default over this driver's LanguageModel.
        const model = Option.getOrElse(Context.getOption(context, Model), () =>
          makeModel(languageModel),
        );
        // capability resolution from the charter's own context,
        // memoized per interpret
        const resolvers = makeResolvers("DriverLocal", termName, context);

        /** The session's meta as the handle persists it. */
        const metaOf = (session: SessionState): SessionMeta => ({
          tick: session.tick,
          observed: session.observed,
          active: [...session.active],
        });

        const observe = (
          session: SessionState,
          observation: DistributiveOmit<
            SessionObservation,
            "term" | "key" | "seq" | "at"
          >,
        ): Effect.Effect<void> =>
          Effect.gen(function* () {
            // live facts (deltas, in-flight tool calls) never persist
            // and never advance the cursor
            const live = isLiveObservation(observation.type);
            const full = {
              ...observation,
              term: termName,
              key: session.key,
              seq: live ? session.observed : session.observed++,
              at: Date.now(),
            } as SessionObservation;
            if (!live) {
              // the durable row and its cursor persist together —
              // a failed write costs restart fidelity, not the round
              yield* session.handle
                .appendObservation(full, metaOf(session))
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      `ThreadStorage append failed for '${session.key}' of '${termName}'`,
                      cause,
                    ),
                  ),
                );
            }
            if (session.sockets.size > 0) {
              const frame: SessionSocketServerFrame = {
                type: "observation",
                durable: !live,
                observation: full,
              };
              for (const send of session.sockets) {
                yield* Effect.ignore(send(frame));
              }
            }
            if (Option.isSome(observer)) {
              yield* observer.value.emit(full).pipe(Effect.ignore);
            }
          });

        /** Append thread rows, tolerating (and logging) a failed
         *  write — persistence must never crash a round. */
        const appendThread = (
          session: SessionState,
          messages: ReadonlyArray<Prompt.MessageEncoded>,
        ): Effect.Effect<void> =>
          messages.length === 0
            ? Effect.void
            : session.handle
                .appendMessages(messages)
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      `ThreadStorage append failed for '${session.key}' of '${termName}'`,
                      cause,
                    ),
                  ),
                );

        // ── the session-scoped AI.Thread / AI.Tick services ─────────
        const makeThreadService = (session: SessionState): ThreadService => ({
          key: session.key,
          tokens: Effect.map(session.handle.messages, (rows) =>
            Math.ceil(JSON.stringify(rows).length / 4),
          ),
          entries: Effect.map(
            session.handle.messages,
            (rows) => Prompt.make([...rows]).content,
          ),
          compact: (plan) =>
            Effect.sync(() => {
              session.pendingCompaction = plan;
            }),
          // ANSWER the current round, from wherever the answer is
          // produced (usually a tool handler) — the caller resolves
          // now; the session neither parks nor ends
          reply: (value) =>
            Effect.gen(function* () {
              for (const waiter of session.waiters.splice(0)) {
                yield* Deferred.succeed(waiter, value);
              }
            }),
          // the driver's CLOCK, fused to the session's lifetime: on the
          // resident host sessions live as long as the process, so a
          // process-scoped fiber is exactly as durable as the session —
          // the DO host implements the same contract with an alarm.
          // Delivery is an ordinary inbox message: a wake if parked,
          // queued if busy, dropped if settled.
          remind: (delay, note) =>
            process.fork(
              Effect.sleep(delay).pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    if (yield* Deferred.isDone(session.settled)) return;
                    yield* Queue.offer(session.inbox, {
                      input: reminderInput(note),
                    });
                  }),
                ),
                Effect.asVoid,
              ),
            ),
        });

        const makeTickService = (session: SessionState): TickService => ({
          count: session.tick,
          say: (note) =>
            Effect.sync(() => {
              session.pendingNotes.push(note);
            }),
        });

        /**
         * Provide the driver-owned services to RUNTIME charter code
         * (turns, splices, tool handlers): `AI.Thread`/`AI.Tick` for
         * THIS session, the captured interpret context (so charter
         * dependencies resolve no matter which fiber the code runs
         * on), and the runtime color.
         */
        const provideSession =
          (session: SessionState) =>
          <A, E>(effect: Effect.Effect<A, E, any>): Effect.Effect<A, E> =>
            effect.pipe(
              Effect.provideService(Thread, makeThreadService(session)),
              Effect.provideService(Tick, makeTickService(session)),
              Effect.provideService(PersistentRef.Store, session.stateStore),
              // the FRAME: refs are namespaced by the session's identity
              PersistentRef.within(termName, session.key),
              Effect.provide(RuntimeContext.phantom),
              Effect.provide(context),
            ) as Effect.Effect<A, E>;

        /**
         * Provide the INIT evaluation context: the captured interpret
         * context, the runtime color, and `AI.Thread` — init runs ONCE
         * PER SESSION at admit, when the thread already exists, so
         * thread-scoped setup (state keyed by `thread.key`, a
         * workspace checkout) belongs here. Deliberately NOT
         * `AI.Tick`: no sampling is under way during init.
         * `CharterServices` enforces the Tick exclusion at the type
         * level; an init that sneaks a `yield* AI.Tick` past it dies
         * here with a missing-service defect.
         */
        const provideInit =
          (session: SessionState) =>
          <A, E>(effect: Effect.Effect<A, E, any>): Effect.Effect<A, E> =>
            effect.pipe(
              Effect.provideService(Thread, makeThreadService(session)),
              Effect.provideService(PersistentRef.Store, session.stateStore),
              // the FRAME: refs are namespaced by the session's identity
              PersistentRef.within(termName, session.key),
              Effect.provide(RuntimeContext.phantom),
              Effect.provide(context),
            ) as Effect.Effect<A, E>;

        /** The host adapter the shared algorithm consumes — this
         *  host backs it with in-process SessionState. */
        const makeOps = (session: SessionState): SessionOps => ({
          driver: "DriverLocal",
          term: termName,
          key: session.key,
          context,
          provide: provideSession(session),
          turn: () => session.turn!,
          tick: () => session.tick,
          clearNotes: () => {
            session.pendingNotes.length = 0;
          },
          observe: (observation) => observe(session, observation),
          // this host's observe routes live/durable by type itself
          observeLive: (observation) => observe(session, observation),
          activeSkills: () => session.active,
          setSkill: (name, active) =>
            Effect.sync(() => {
              if (active) session.active.add(name);
              else session.active.delete(name);
            }),
          lastStance: () => session.lastStance,
          setLastStance: (stance) => {
            session.lastStance = stance;
          },
          registerChild: (agent, childKey, actor) => {
            session.children.set(`${agent}:${childKey}`, {
              key: childKey,
              actor,
            });
          },
          spawn: (params) => spawn(session, params),
        });

        const sessions = new Map<string, SessionState>();
        // Minted keys are PROCESS-UNIQUE, not just driver-unique:
        // session identity leaks into the world (workspace checkouts
        // key on `AI.Thread.key`), so a bare counter would collide
        // across restarts — a fresh process's `session-0` would
        // inherit the previous process's `session-0` worktree, stale
        // work included.
        const mintPrefix = crypto.randomUUID().slice(0, 8);
        let minted = 0;
        let lastKey: string | undefined;

        const makeSessionState = (key: string): Effect.Effect<SessionState> =>
          Effect.gen(function* () {
            return {
              inbox: yield* Queue.unbounded<InboxItem>(),
              quiet: [],
              waiters: [],
              settled: yield* Deferred.make<unknown>(),
              key,
              handle: yield* threadStorage.open(termName, key),
              active: new Set<string>(),
              tick: 0,
              pendingNotes: [],
              observed: 0,
              sockets: new Set(),
              children: new Map(),
              // an ambient store (org-provided sqlite, DO storage)
              // makes charter refs durable; the session frame
              // (within(term, key)) keeps per-session isolation on the
              // shared store. Absent: exactly as durable as the session.
              stateStore: Option.isSome(ambientStore)
                ? ambientStore.value
                : PersistentRef.makeMemoryStore(),
            };
          });

        /** Apply a requested compaction at the tick boundary —
         *  the shared plan application over this session's handle. */
        const applyCompaction = (session: SessionState): Effect.Effect<void> =>
          Effect.suspend(() => {
            const plan = session.pendingCompaction;
            if (plan === undefined) return Effect.void;
            session.pendingCompaction = undefined;
            return applyCompactionPlan(session.handle, plan);
          });

        // the intrinsic spawn: an ANONYMOUS session with the spawner's
        // system prompt REPLACED by the written role, and a subset of
        // the spawner's CURRENT tick's tools/skills — never
        // spawn/dispatch (workers are leaves). A worker's stance is
        // its written instructions: constant, no turn.
        const spawn = (
          spawner: SessionState,
          params: SpawnParams,
        ): Effect.Effect<unknown> =>
          Effect.gen(function* () {
            const stance = spawner.lastStance!;
            const worker = yield* makeSessionState(
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
              const resolved = yield* resolvers.resolveHandler(compiled);
              handlers[name] = (input) =>
                provideSession(worker)(resolved(input));
            }
            // handed skills arrive PRE-ACTIVATED: prose joins the
            // worker's instructions, tools join its (fixed) toolkit
            const handed: Array<{ name: string } & ResolvedSkill> = [];
            for (const name of params.skills ?? []) {
              const skillTerm = stance.skills.get(name);
              if (skillTerm === undefined) continue;
              const resolved = yield* resolvers.resolveSkill(skillTerm);
              handed.push({ name, ...resolved });
              for (const [toolName, fn] of Object.entries(resolved.handlers)) {
                handlers[toolName] ??= (input) =>
                  provideSession(worker)(fn(input));
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

        const loop = (
          session: SessionState,
          prepare: (
            session: SessionState,
            inputs: ReadonlyArray<unknown>,
          ) => Effect.Effect<TickResult>,
        ) =>
          Effect.gen(function* () {
            const ops = makeOps(session);
            // starts QUIESCENT: a session created without input (a
            // socket attach `ensure`s it; the admitting offer may lose
            // the startup race) parks on the queue instead of sampling
            // an empty thread
            let quiescent = true;
            // consecutive malformed-tool-call feedback rounds — resets
            // on any well-formed sampling
            let malformed = 0;
            while (true) {
              if (yield* Deferred.isDone(session.settled)) break;
              let items: Array<InboxItem> = yield* Queue.clear(session.inbox);
              if (items.length === 0 && quiescent) {
                // PARKED: the session's work is done until the world
                // moves. Everything durable is already written through
                // the handle, so parking is just waiting. Quiet inputs
                // deliberately DON'T factor in — they accumulate as
                // context and never wake a parked session.
                yield* observe(session, { type: "parked" });
                const wake = yield* Effect.raceFirst(
                  Effect.map(Queue.take(session.inbox), (item) => ({
                    settled: false as const,
                    item,
                  })),
                  Effect.map(Deferred.await(session.settled), () => ({
                    settled: true as const,
                  })),
                );
                if (wake.settled) break;
                items = [wake.item, ...(yield* Queue.clear(session.inbox))];
              }
              // quiet inputs JOIN whatever round is happening anyway —
              // prepended (they arrived earlier), never a wake themselves
              items = [...session.quiet.splice(0), ...items];
              // boundary work: requested compaction applies BEFORE the
              // new inputs join the thread, so nothing fresh is lost
              yield* applyCompaction(session);
              // drained waiters JOIN THE ROUND: only now are they
              // answerable — by AI.reply, or by quiescence as fallback
              const drained: Array<{
                readonly value: unknown;
                readonly kind?: "reminder";
              }> = [];
              for (const item of items) {
                drained.push(inputProvenance(item.input));
                if (item.waiter !== undefined) {
                  session.waiters.push(item.waiter);
                }
              }
              const inputs = drained.map((item) => item.value);
              for (const { value, kind } of drained) {
                yield* appendThread(session, [asUserMessage(value)]);
                yield* observe(session, {
                  type: "input",
                  text:
                    typeof value === "string" ? value : JSON.stringify(value),
                  kind,
                });
              }
              // TICK: re-evaluate the stance before every sampling —
              // function turns receive the tick event ({count, inputs})
              const tick = yield* prepare(session, inputs);
              // deliver collected notes (`AI.say`): a PLAIN append, in
              // emission order — no dedupe, no memory. The author's
              // condition (`if (count === 30) yield* AI.say…`) is the
              // whole delivery policy.
              for (const note of session.pendingNotes.splice(0)) {
                const text = render(note.template as TemplateStringsArray, [
                  ...note.refs,
                ]);
                if (text.length === 0) continue;
                yield* appendThread(session, [noteMessage(text)]);
                yield* observe(session, {
                  type: "input",
                  text: `<note>\n${text}\n</note>`,
                  kind: "note",
                });
              }
              const outcome = yield* sampleTick({
                ops,
                model,
                handle: session.handle,
                tick,
                exhausted: malformed >= model.malformedBudget,
              });
              if (outcome.kind === "malformed") {
                malformed++;
                quiescent = false; // come straight back around and re-sample
                continue;
              }
              malformed = 0;
              const response = outcome.response;
              session.tick++;
              yield* session.handle
                .putMeta(metaOf(session))
                .pipe(Effect.ignore);
              quiescent = response.toolCalls.length === 0;
              if (quiescent) {
                for (const waiter of session.waiters.splice(0)) {
                  yield* Deferred.succeed(waiter, response.text);
                }
              }
            }
            // settled: anyone still waiting gets the outcome — the
            // current round's waiters AND undrained arrivals alike
            const outcome = yield* Deferred.await(session.settled);
            yield* observe(session, { type: "settled" });
            // settled sessions are never restored — drop the persisted
            // row
            yield* threadStorage
              .remove(termName, session.key)
              .pipe(Effect.ignore);
            for (const item of yield* Queue.clear(session.inbox)) {
              if (item.waiter !== undefined) session.waiters.push(item.waiter);
            }
            for (const waiter of session.waiters.splice(0)) {
              yield* Deferred.succeed(waiter, outcome);
            }
            yield* settleChildren(session);
          });

        /**
         * The SUPERVISION cascade: a settled (or crashed) session
         * settles every session worker it dispatched — parked workers
         * must not outlive the conversation that owns them.
         */
        const settleChildren = (session: SessionState): Effect.Effect<void> =>
          Effect.forEach(
            [...session.children.values()],
            ({ key, actor }) =>
              actor
                .settle(key, {
                  supervisor: { term: termName, key: session.key },
                })
                .pipe(Effect.provide(RuntimeContext.phantom)),
            { discard: true },
          ).pipe(Effect.andThen(Effect.sync(() => session.children.clear())));

        /** The default per-session tick: the shared algorithm over
         *  this host's adapter. */
        const actorTick = (
          session: SessionState,
          inputs: ReadonlyArray<unknown>,
        ): Effect.Effect<TickResult> =>
          compileTick(makeOps(session), resolvers, inputs);

        /** Fork a session's loop onto the process Scope. */
        const startLoop = (
          session: SessionState,
          prepare: (
            session: SessionState,
            inputs: ReadonlyArray<unknown>,
          ) => Effect.Effect<TickResult>,
        ) =>
          process.fork(
            loop(session, prepare).pipe(
              // a crashed loop must never strand its callers: the
              // failure exit propagates to every waiter (dispatch
              // dies with the same defect) and marks the session ended
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? Effect.gen(function* () {
                      // fire-and-forget deliveries (`send`) have no waiter
                      // to die with — the log is their only witness
                      yield* Effect.logError(
                        `Driver session '${session.key}' of '${termName}' crashed`,
                        exit.cause,
                      );
                      const crash = describeCrash(exit.cause);
                      // the crash note is durable — crashed threads
                      // restore parked; the next input resumes
                      yield* observe(session, {
                        type: "crashed",
                        error: crash.encoded,
                        fatal: !crash.encoded.retryable,
                      });
                      for (const waiter of session.waiters.splice(0)) {
                        yield* Deferred.done(waiter, exit as Exit.Exit<never>);
                      }
                      yield* Deferred.done(
                        session.settled,
                        exit as Exit.Exit<never>,
                      );
                      // a crashed supervisor takes its session workers
                      // down with it, same as a settled one
                      yield* settleChildren(session);
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

        /** Create-or-get a session WITHOUT admitting input — the
         *  session's init and loop start; the inbox stays untouched.
         *  This is what a socket ATTACH uses: observing a session must
         *  not feed it. */
        const ensure = (
          key?: string,
          parent?: { readonly term: string; readonly key: string },
        ) =>
          Effect.gen(function* () {
            const sessionKey = key ?? `session-${mintPrefix}-${minted++}`;
            let session = sessions.get(sessionKey);
            if (session === undefined) {
              session = yield* makeSessionState(sessionKey);
              yield* observe(session, { type: "admitted", parent });
              // per-session init: the thread exists (Thread in scope
              // for thread-scoped setup); no sampling yet (no Tick)
              const initResult = yield* provideInit(session)(
                charter as Effect.Effect<unknown, unknown>,
              ).pipe(Effect.orDie);
              session.turn = isFragment(initResult)
                ? Effect.succeed(initResult)
                : Effect.isEffect(initResult)
                  ? (initResult as Turn)
                  : typeof initResult === "function"
                    ? (initResult as TurnFn)
                    : yield* Effect.die(
                        `DriverLocal: the charter for '${termName}' returned neither prose, a turn effect, nor a turn function`,
                      );
              yield* startLoop(session, actorTick);
              sessions.set(sessionKey, session);
            }
            lastKey = sessionKey;
            return session;
          });

        const admit = (
          item: InboxItem,
          key?: string,
          parent?: { readonly term: string; readonly key: string },
          wake = true,
        ) =>
          Effect.gen(function* () {
            const session = yield* ensure(key, parent);
            if (!(yield* Deferred.isDone(session.settled))) {
              if (wake) {
                yield* Queue.offer(session.inbox, item);
              } else {
                session.quiet.push(item);
              }
            }
            return session;
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
              const session = yield* admit(
                { input: item, waiter },
                options?.key,
                options?.parent,
              );
              if (yield* Deferred.isDone(session.settled)) {
                return yield* Deferred.await(session.settled);
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
              const session = sessions.get(key);
              if (session === undefined) {
                // crash recovery: a KEYED steer must never be silently
                // dropped — the session's state died with the isolate
                // but the world's event is real; admit a fresh session
                if (second !== undefined) {
                  yield* Effect.asVoid(admit({ input }, key));
                }
                return;
              }
              if (yield* Deferred.isDone(session.settled)) return;
              yield* Queue.offer(session.inbox, { input });
            })) as Actor["steer"],
          settle: (sessionKey, event) =>
            Effect.gen(function* () {
              const session = sessions.get(sessionKey);
              if (session === undefined) return;
              // idempotent: a second settle changes nothing
              yield* Deferred.succeed(session.settled, event);
            }),
          interrupt: () =>
            Effect.gen(function* () {
              for (const session of sessions.values()) {
                yield* Deferred.succeed(session.settled, {
                  interrupted: true,
                });
              }
            }),
        };
        // the socket door: what `AgentGateway.attach` resolves a term
        // to — ensure (never feeds the session) plus the submit sink
        socketHosts.set(termName, {
          ensure: (key: string) => ensure(key),
          submit: (key: string, input: unknown) =>
            Effect.asVoid(admit({ input }, key)),
        });
        // ── RESTORE (bootstrap §3): persisted sessions come back
        // PARKED, threads primed, seq cursor continued. Init re-runs —
        // the charter closure is the instance, rebuilt from CURRENT
        // code (level-triggered: the next tick renders the new stance).
        // No `admitted` observation: the projection already has the
        // session's history; restored sessions emit nothing until they
        // wake.
        {
          const persisted = yield* threadStorage
            .keys(termName)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.as(
                  Effect.logWarning(
                    `ThreadStorage restore failed for '${termName}'`,
                    cause,
                  ),
                  [] as ReadonlyArray<string>,
                ),
              ),
            );
          if (persisted.length > 0) {
            yield* Effect.logInfo(
              `Driver '${termName}': restoring ${persisted.length} session(s) from storage`,
            );
          }
          for (const sessionKey of persisted) {
            if (sessions.has(sessionKey)) continue;
            const session = yield* makeSessionState(sessionKey);
            const meta = yield* session.handle.meta.pipe(
              Effect.catchCause((cause) =>
                Effect.as(
                  Effect.logWarning(
                    `ThreadStorage: meta for '${sessionKey}' of '${termName}' failed to read — starting without it`,
                    cause,
                  ),
                  undefined,
                ),
              ),
            );
            if (meta === undefined) continue;
            session.tick = meta.tick;
            session.observed = meta.observed;
            for (const skill of meta.active) session.active.add(skill);
            const initResult = yield* provideInit(session)(
              charter as Effect.Effect<unknown, unknown>,
            ).pipe(Effect.orDie);
            session.turn = isFragment(initResult)
              ? Effect.succeed(initResult)
              : Effect.isEffect(initResult)
                ? (initResult as Turn)
                : typeof initResult === "function"
                  ? (initResult as TurnFn)
                  : yield* Effect.die(
                      `DriverLocal: the charter for '${termName}' returned neither prose, a turn effect, nor a turn function`,
                    );
            // The session is REGISTERED synchronously (admits/ensures
            // find its inbox and queue into it), but the loop start
            // must not block the BUILD: `startLoop` awaits the Host
            // program starting, which a plan-time build never does.
            // `runOnHost` registers it as a program runner — a
            // planner registers-and-discards (no restore in a
            // planner, no hang); the real runtime starts the loop the
            // moment `exports.program` runs, draining anything the
            // inbox queued meanwhile.
            yield* runOnHost(startLoop(session, actorTick)).pipe(
              Effect.asVoid,
            ) as Effect.Effect<void>;
            sessions.set(sessionKey, session);
            yield* Effect.logInfo(
              `Driver '${termName}': restored session '${sessionKey}' parked at tick ${meta.tick}`,
            );
          }
        }
        return actor;
      });

    /**
     * The local {@link AgentGateway}: the SAME protocol the Cloudflare
     * driver speaks from its Durable Objects, served in-process — a
     * WebSocket upgrade on the host's own HTTP server, replay from
     * the session's handle, live broadcast from `observe`.
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
            `DriverLocal: no interpreted term '${term}' to attach to — has its Layer been built?`,
          );
        }
        const session = yield* host.ensure(key);
        const socket = yield* request.upgrade.pipe(Effect.orDie);
        const serve = Effect.gen(function* () {
          const write = yield* socket.writer;
          const send = (frame: SessionSocketServerFrame): Effect.Effect<void> =>
            Effect.asVoid(
              Effect.ignore(write(JSON.stringify(frame))),
            ) as Effect.Effect<void>;
          const handle = handleSessionSocketFrame(
            {
              replay: (fromSeq) => session.handle.observations(fromSeq),
              watermark: Effect.sync(() => session.observed),
              submit: (input) => host.submit(key, input),
            },
            send,
          );
          session.sockets.add(send);
          yield* socket
            .runString((raw: string) =>
              handle(JSON.parse(raw) as SessionSocketClientFrame).pipe(
                Effect.catchDefect((defect) =>
                  Effect.logWarning(`[session-socket] bad frame: ${defect}`),
                ),
              ),
            )
            .pipe(
              Effect.ignore,
              Effect.ensuring(Effect.sync(() => session.sockets.delete(send))),
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
