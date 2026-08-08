/**
 * The Cloudflare driver — the same `AI.Driver` contract as
 * `AI.DriverMemory`, with sessions hosted on Durable Objects: ONE DO
 * instance per session (named `${term}/${key}`), the thread and inbox in
 * DO storage, `Thread.remind` on the DO alarm, actor verbs as RPC.
 *
 * Swapping substrates is one line:
 *
 * ```ts
 * const OrgAgents = Layer.mergeAll(IssueOwnerLive, EngineerLayer).pipe(
 *   Layer.provideMerge(Cloudflare.AI.DriverCloudflare),   // ← or AI.DriverMemory
 *   Layer.provideMerge(Model),
 * );
 *
 * export default class OrgWorker extends Cloudflare.Worker<OrgWorker>()(
 *   "OrgWorker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const owner = yield* IssueOwner;
 *     yield* GitHub.consumeRepositoryEvents(repo, { events }, route(owner));
 *     return { fetch };
 *   }),
 *   OrgAgents,                                            // ← the layers slot
 * ) {}
 * ```
 *
 * ## How a charter reaches the DO
 *
 * A charter is CODE and cannot cross the wire — and it doesn't need
 * to: the Worker and its DO classes share ONE memoized layer build per
 * isolate (`WorkerBridge.getSharedBuild`), and the class-level
 * `layers` slot IS that build. So the agent layers build on the DO
 * side too, their `interpret` calls record `term → {charter, captured
 * context}` in this driver's registrations, and the `AgentSessions` DO —
 * declared here, discovered as a binding because the layer yields it
 * during init — closes over that same map. An activating DO parses its
 * own name and becomes that session.
 *
 * Because the actor verbs are uniform, a door fired INSIDE a session RPCs
 * to the delegate's own DO: cross-session delegation is cross-DO by
 * construction.
 *
 * v1 (direct implementation — see designs/ai/driver-cloudflare.md):
 * `dispatch` holds its RPC open for the round (DriverMemory's exact
 * call/reply semantics); durable continuations, compaction, and wire
 * modes come with the layering phase.
 */
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { isAiError, type AiError } from "effect/unstable/ai/AiError";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Prompt from "effect/unstable/ai/Prompt";
import * as Response from "effect/unstable/ai/Response";
import type * as AiTool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import type { Actor, SessionRef } from "../../AI/Actor.ts";
import { isAgent, type Agent } from "../../AI/Agent.ts";
import { isDispatchTool, type DispatchTool } from "../../AI/Dispatch.ts";
import { Refused, type DriverError } from "../../AI/Errors.ts";
import { isEvent } from "../../AI/Event.ts";
import {
  Driver,
  type Charter,
  type Interpretable,
  type Turn,
  type TurnFn,
} from "../../AI/Driver.ts";
import {
  asUserMessage,
  buildToolkit,
  compileDispatch,
  compileSkillTool,
  compileSpawn,
  compileTool,
  dedupeByName,
  describeCrash,
  inputProvenance,
  NOTE_CODA,
  noteMessage,
  reminderInput,
  render,
  type CompiledToolRef,
  type Stance,
} from "../../AI/DriverShared.ts";
import { makeModel, Model } from "../../AI/Model.ts";
import {
  SessionObserver,
  RoundAbandoned,
  type SessionObservation,
} from "../../AI/Observer.ts";
import { isParameter } from "../../AI/Parameter.ts";
import * as PersistentRef from "../../PersistentRef.ts";
import { makeDurableObjectStore } from "../Workers/PersistentRefStore.ts";
import { dedentTemplate, isFragment, type Fragment } from "../../AI/Prose.ts";
import {
  AgentGateway,
  handleSessionSocketFrame,
  type SessionSocketClientFrame,
  type SessionSocketServerFrame,
} from "../../AI/SessionSocket.ts";
import { isSkill, type Skill, type SkillService } from "../../AI/Skill.ts";
import {
  Thread,
  Tick,
  type ThreadService,
  type TickService,
} from "../../AI/Thread.ts";
import { isTool, isToolImpl } from "../../AI/Tool.ts";
import type { HttpEffect } from "../../Http.ts";
import type { MainRpc } from "../../Platform.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import { DurableObject } from "../Workers/DurableObject.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import { upgrade, type WebSocket } from "../Workers/WebSocket.ts";
import { Worker } from "../Workers/Worker.ts";

/** What one `interpret` call recorded — all the session engine needs to
 *  BECOME a session of this term when a DO activates. */
interface RegisteredCharter {
  readonly charter: Charter;
  /** The charter's own Layer graph, captured at interpret — tools,
   *  doors, and delegates resolve from it as on DriverMemory. */
  readonly context: Context.Context<never>;
  /** The delegate actors this term may reach (resolved lazily). */
  readonly term: Interpretable;
}

/** The DO name addressing one session of one term: `${term}/${key}`. */
const sessionName = (termName: string, key: string) => `${termName}/${key}`;

/** Split a DO name back into its term and key halves. The key may
 *  itself contain slashes (session keys are `${parent}/${agent}/${s}`),
 *  so only the FIRST segment is the term. */
const parseSessionName = (name: string) => {
  const at = name.indexOf("/");
  return at < 0
    ? { term: name, key: name }
    : { term: name.slice(0, at), key: name.slice(at + 1) };
};

// ── storage layout (one session per DO) ──────────────────────────────────
// inbox:{seq}      pending inputs, drained per burst
// msg:{seq}        thread messages, appended (the transcript)
// obs:{seq}        durable observations — the session's own projection,
//                  replayable from any cursor (the chat/board source)
// remind:{fireAt}  scheduled notes (the alarm re-arms from these)
// meta             { tick, observed, active[], settled?, drained, busy? }
const INBOX = "inbox:";
const MSG = "msg:";
const OBS = "obs:";
const REMIND = "remind:";
const META = "meta";

/** Zero-padded so lexical key order IS arrival order. */
const seqKey = (prefix: string, seq: number) =>
  `${prefix}${String(seq).padStart(12, "0")}`;

const seqOf = (prefix: string, key: string) => Number(key.slice(prefix.length));

interface SessionMeta {
  readonly tick: number;
  readonly observed: number;
  readonly active: ReadonlyArray<string>;
  readonly settled?: { readonly outcome: unknown };
  readonly seq: number;
  /**
   * The drain WATERMARK: inbox rows below this seq are already in the
   * thread. Inputs are appended (with this watermark advanced, in one
   * atomic write) BEFORE their inbox rows are deleted, so a crash
   * between the two redelivers rows the watermark tells us to discard
   * — at-least-once drain, exactly-once append.
   */
  readonly drained: number;
  /**
   * The LIVENESS marker, following think's `cf_agents_runs` design
   * (designs/ai/reports/think-durable-execution.md): present while a
   * burst owes the thread a reply, cleared at quiescence. A burst that
   * finds it already set on entry knows its predecessor DIED mid-round
   * — eviction, deploy, or crash, all indistinguishable and all
   * recovered the same way. `attempts` counts consecutive re-entries
   * on the SAME round; any completed sampling resets it (progress-
   * keyed budgets, not wall-clock).
   */
  readonly busy?: { readonly attempts: number; readonly since: number };
}

const emptyMeta: SessionMeta = {
  tick: 0,
  observed: 0,
  active: [],
  seq: 0,
  drained: 0,
};

/**
 * Tuning for the recovery machinery — optional; tests shrink it so
 * recovery is observable in seconds.
 */
export class DriverDurability extends Context.Service<
  DriverDurability,
  {
    /** Base delay before the recovery alarm re-enters a silent round
     *  (doubles per attempt, capped at 8×). @default 30 seconds */
    readonly recoverAfterMillis?: number;
    /** Re-entries on the same round before it is abandoned with an
     *  interruption note. @default 5 */
    readonly maxAttempts?: number;
  }
>()("alchemy/Cloudflare/AI/DriverDurability") {}

/** The thread crosses storage in its ENCODED form — rows are JSON. */
const encodeMessages = S.encodeSync(S.Array(Prompt.Message));

type DistributiveOmit<T, K extends PropertyKey> = T extends any
  ? Omit<T, K>
  : never;

/**
 * A session's RPC surface — the {@link Actor} verbs, as one DO speaks them.
 * Uniform across every agent, which is what makes delegation
 * cross-DO for free: a door fired inside a session calls these on the
 * delegate's own instance.
 */
interface SessionRpc extends MainRpc<DurableObjectState> {
  readonly deliver: (
    input: unknown,
    options?: { readonly parent?: SessionRef; readonly wake?: boolean },
  ) => Effect.Effect<void, unknown, RuntimeContext>;
  readonly dispatch: (
    input: unknown,
    options?: { readonly parent?: SessionRef },
  ) => Effect.Effect<unknown, unknown, RuntimeContext>;
  readonly steer: (
    input: unknown,
  ) => Effect.Effect<void, unknown, RuntimeContext>;
  readonly settle: (
    outcome: unknown,
  ) => Effect.Effect<void, unknown, RuntimeContext>;
  readonly alarm: () => Effect.Effect<void, unknown, RuntimeContext>;
  /** The live-view seam: WebSocket attach + the session-socket frames. */
  readonly fetch: HttpEffect<DurableObjectState | RuntimeContext>;
  readonly webSocketMessage: (
    socket: WebSocket,
    message: string | ArrayBuffer,
  ) => Effect.Effect<void>;
  readonly webSocketClose: (
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) => Effect.Effect<void>;
}

export { AgentGateway } from "../../AI/SessionSocket.ts";

/**
 * The `AI.Driver` for Cloudflare — no argument, and no class for the
 * user to declare: the sessions DO is declared in this module and
 * discovered as a binding because this layer YIELDS it while building.
 *
 * It requires `Worker` for exactly that reason: the binding attaches
 * to the host whose bundle carries the class, so this layer only
 * builds inside a Worker (or a DO of one). That is the whole
 * difference from `AI.DriverMemory`'s `Layer<Driver, never,
 * LanguageModel>` — the substrate is in the type.
 */
export const DriverCloudflare: Layer.Layer<
  Driver | AgentGateway,
  never,
  LanguageModel.LanguageModel | Worker
> = Layer.effectContext(
  Effect.gen(function* () {
    const languageModel = yield* LanguageModel.LanguageModel;
    const registrations = new Map<string, RegisteredCharter>();

    /**
     * The sessions namespace: ONE Durable Object for every agent — the term
     * prefix of the instance name says which charter an activation
     * becomes. Declared HERE, not by the user, and closed over
     * `registrations`, which the shared layer build populates before
     * any activation's constructor sessions.
     */
    const sessions = yield* DurableObject<SessionRpc>()(
      "AgentSessions",
      Effect.gen(function* () {
        const state = yield* DurableObjectState;
        const storage = state.storage;
        /**
         * WHO THIS ACTIVATION IS, read lazily. The constructor's outer
         * effect also runs at PLAN time — against a mock state with no
         * id — to discover this binding, so nothing here may touch the
         * instance eagerly. Every read below happens inside a
         * request-time effect.
         */
        let identity:
          | { readonly term: string; readonly key: string }
          | undefined;
        const me = {
          get term() {
            return (identity ??= parseSessionName(String(state.id.name))).term;
          },
          get key() {
            return (identity ??= parseSessionName(String(state.id.name))).key;
          },
        };

        // ── durable state accessors ─────────────────────────────────
        const readMeta = Effect.map(
          storage.get<SessionMeta>(META).pipe(Effect.orDie),
          (found) => found ?? emptyMeta,
        );
        const writeMeta = (meta: SessionMeta) =>
          storage.put(META, meta).pipe(Effect.orDie);

        const listRows = <A>(prefix: string) =>
          storage.list<A>({ prefix }).pipe(
            Effect.orDie,
            Effect.map((map) => [...map.entries()]),
          );

        const readThread = Effect.map(
          listRows<Prompt.MessageEncoded>(MSG),
          (rows) => Prompt.make(rows.map(([, message]) => message)),
        );

        const appendThread = (messages: ReadonlyArray<Prompt.MessageEncoded>) =>
          Effect.gen(function* () {
            if (messages.length === 0) return;
            const meta = yield* readMeta;
            const entries: Record<string, unknown> = {};
            let seq = meta.seq;
            for (const message of messages) {
              entries[seqKey(MSG, seq++)] = message;
            }
            yield* storage.put(entries).pipe(Effect.orDie);
            yield* writeMeta({ ...meta, seq });
          });

        // ── observations ────────────────────────────────────────────
        const captured = yield* Effect.context<never>();
        const observer = Context.getOption(captured, SessionObserver);
        const durability = Option.getOrElse(
          Context.getOption(captured, DriverDurability),
          () => ({}) as (typeof DriverDurability)["Service"],
        );
        const recoverAfter = durability.recoverAfterMillis ?? 30_000;
        const maxAttempts = durability.maxAttempts ?? 5;
        // the MODEL seam (driver-assembly.md §3): a user driver
        // provides its own (retry/budget/tiering policy lives inside
        // it); absent, the default over this driver's LanguageModel.
        const model = Option.getOrElse(Context.getOption(captured, Model), () =>
          makeModel(languageModel),
        );

        /**
         * ONE alarm, re-armed after every mutation to the earliest of
         * its consumers: the next reminder, and the recovery deadline
         * of an open round (backed off per attempt). A stale alarm
         * firing after the work is done just parks — never cleared,
         * only outraced.
         */
        const armAlarm = Effect.gen(function* () {
          const meta = yield* readMeta;
          const reminders = yield* listRows<string>(REMIND);
          const deadlines = reminders.map(([k]) => seqOf(REMIND, k));
          if (meta.busy !== undefined && meta.settled === undefined) {
            deadlines.push(
              meta.busy.since +
                recoverAfter * 2 ** Math.min(meta.busy.attempts, 3),
            );
          }
          if (deadlines.length === 0) return;
          yield* storage.setAlarm(Math.min(...deadlines)).pipe(Effect.orDie);
        });
        /**
         * Fan a wire frame out to every attached socket. `sendIfOpen`
         * discipline: a closing socket's send throws and is IGNORED —
         * the client owns catch-up via `subscribe { fromSeq }`, so a
         * dropped frame is never an error, only a gap the cursor
         * closes. Sockets are re-read from the runtime each time (no
         * in-memory session map to rehydrate after hibernation).
         */
        const broadcast = (frame: SessionSocketServerFrame) =>
          Effect.gen(function* () {
            // runtime-colored, but only ever called from inside a DO
            // event — seal rather than thread the phantom capability
            // through every observation site
            const sockets = yield* Effect.provide(
              state.getWebSockets(),
              RuntimeContext.phantom,
            );
            if (sockets.length === 0) return;
            const data = JSON.stringify(frame);
            for (const socket of sockets) {
              yield* Effect.ignore(Effect.try(() => socket.ws.send(data)));
            }
          });

        /**
         * A DURABLE observation: written as a row (the replay log —
         * this session's own projection) with the watermark bump in ONE
         * atomic write, then fanned out to attached sockets and the
         * external observer. The row is the record; delivery is
         * best-effort on both channels.
         */
        const observe = (
          observation: DistributiveOmit<
            SessionObservation,
            "term" | "key" | "seq" | "at"
          >,
        ) =>
          Effect.gen(function* () {
            const meta = yield* readMeta;
            const full = {
              ...observation,
              term: me.term,
              key: me.key,
              seq: meta.observed,
              at: Date.now(),
            } as SessionObservation;
            yield* storage
              .put({
                [seqKey(OBS, meta.observed)]: full,
                [META]: { ...meta, observed: meta.observed + 1 },
              })
              .pipe(Effect.orDie);
            yield* broadcast({
              type: "observation",
              durable: true,
              observation: full,
            });
            if (Option.isSome(observer)) {
              yield* observer.value.emit(full).pipe(Effect.ignore);
            }
          });

        /**
         * A LIVE observation — token deltas, in-flight tool calls:
         * broadcast and emitted but never a row, and the cursor does
         * not advance (`seq` repeats the current watermark). A client
         * that missed them is covered by the durable `assistant`
         * restatement of the whole sampling.
         */
        const observeLive = (
          observation: DistributiveOmit<
            SessionObservation,
            "term" | "key" | "seq" | "at"
          >,
        ) =>
          Effect.gen(function* () {
            const meta = yield* readMeta;
            const full = {
              ...observation,
              term: me.term,
              key: me.key,
              seq: meta.observed,
              at: Date.now(),
            } as SessionObservation;
            yield* broadcast({
              type: "observation",
              durable: false,
              observation: full,
            });
            if (Option.isSome(observer)) {
              yield* observer.value.emit(full).pipe(Effect.ignore);
            }
          });

        /**
         * The round's waiters: `dispatch` RPCs held open for this
         * burst. v1 keeps them in memory — an eviction mid-round fails
         * the caller, which re-drives from the world (durable
         * continuations are the layering phase).
         */
        const waiters: Array<Deferred.Deferred<unknown, unknown>> = [];
        const pendingNotes: Array<Fragment> = [];
        /** Session children, for the supervision cascade. */
        const children = new Map<string, { term: string; key: string }>();

        const resolveWaiters = (value: unknown) =>
          Effect.forEach(waiters.splice(0), (w) => Deferred.succeed(w, value), {
            discard: true,
          });
        const failWaiters = (error: unknown) =>
          Effect.forEach(waiters.splice(0), (w) => Deferred.fail(w, error), {
            discard: true,
          });

        // ── the session-scoped AI.Thread / AI.Tick services ─────────────
        // storage is a RUNTIME capability; the session-scoped services the
        // driver hands userland are plain effects, so seal it here
        const sealed = <A>(
          effect: Effect.Effect<A, never, RuntimeContext>,
        ): Effect.Effect<A> => Effect.provide(effect, RuntimeContext.phantom);

        const threadService: ThreadService = {
          get key() {
            return me.key;
          },
          tokens: sealed(
            Effect.map(readThread, (prompt) =>
              Math.ceil(JSON.stringify(prompt.content).length / 4),
            ),
          ),
          entries: sealed(Effect.map(readThread, (prompt) => prompt.content)),
          // v1: compaction is not yet applied on this substrate (the
          // thread is row-addressed; the plan lands with the layering
          // phase). Recording the request keeps the contract honest.
          compact: () => Effect.void,
          reply: (value) => resolveWaiters(value),
          // the DRIVER's clock, durable by construction: a row plus
          // the DO alarm. Delivery is an ordinary inbox message — a
          // wake if parked, queued if busy, dropped if settled.
          remind: (delay, note) =>
            sealed(
              Effect.gen(function* () {
                const fireAt = Date.now() + Duration.toMillis(delay);
                yield* storage.put(seqKey(REMIND, fireAt), note);
                yield* armAlarm;
              }),
            ),
        };

        /**
         * The session's `PersistentRef.Store`: DO storage rows under the
         * session's own prefix, written through the synchronous KV API —
         * write coalescing + the output gate make writes durable before
         * anything leaves the DO. ONE instance per activation:
         * `PersistentRef` memoizes refs per store instance, so every
         * `make` of a name within this activation shares one in-memory
         * cache. Building the object only captures `state`; storage is
         * touched lazily.
         */
        const stateStore = makeDurableObjectStore(state);

        const provideRun = <A, E>(
          effect: Effect.Effect<A, E, any>,
          registration: RegisteredCharter,
          tick: TickService,
        ): Effect.Effect<A, E> =>
          effect.pipe(
            Effect.provideService(Thread, threadService),
            Effect.provideService(Tick, tick),
            Effect.provideService(PersistentRef.Store, stateStore),
            // The FRAME: every ref this session makes is namespaced by the
            // session's durable identity, so isolation is a logical
            // property of the key — not an accident of this store
            // being per-DO — and survives a swap to a shared store.
            PersistentRef.within(me.term, me.key),
            Effect.provide(RuntimeContext.phantom),
            Effect.provide(registration.context),
          ) as Effect.Effect<A, E>;

        // ── capability resolution (from the charter's own context) ───
        const resolveHandler = (
          registration: RegisteredCharter,
          compiled: CompiledToolRef,
        ) =>
          Effect.gen(function* () {
            if (compiled.impl !== undefined) return compiled.impl;
            const name = compiled.term["~alchemy/Name"];
            const service = Context.getOption(
              registration.context,
              compiled.term as any,
            );
            if (Option.isNone(service)) {
              return yield* Effect.die(
                `DriverCloudflare: no implementation provided for tool '${name}' of '${me.term}'`,
              );
            }
            return service.value as (
              params: any,
            ) => Effect.Effect<any, any, any>;
          });

        const resolveSkill = (
          registration: RegisteredCharter,
          skill: Skill<string, any>,
        ) =>
          Effect.gen(function* () {
            const name = skill["~alchemy/Name"];
            const service = Context.getOption(
              registration.context,
              skill as any,
            );
            if (Option.isNone(service)) {
              return yield* Effect.die(
                `DriverCloudflare: no implementation provided for skill '${name}'`,
              );
            }
            // the IMPLEMENTATION carries the teaching: prose, spliced
            // tools, and their physics all come from the resolved
            // service — the term is only the name
            const impl = service.value as SkillService;
            const skillTools = impl.refs.filter(isTool);
            const handlers: Record<
              string,
              (params: any) => Effect.Effect<any, any, any>
            > = {};
            for (const tool of skillTools) {
              const toolName = tool["~alchemy/Name"];
              const resolved = impl.tools[toolName];
              if (resolved === undefined) {
                return yield* Effect.die(
                  `DriverCloudflare: skill '${name}' implementation provides no tool '${toolName}'`,
                );
              }
              handlers[toolName] = resolved;
            }
            return {
              prose: render(impl.template, impl.refs),
              tools: skillTools.map(compileTool),
              handlers,
              // a teaching may reference DEEPER skills: activating this
              // one exposes them for activation — the skill GRAPH
              skills: impl.refs.filter(isSkill),
            };
          });

        const resolveDelegate = (
          registration: RegisteredCharter,
          agent: Agent<any, any>,
        ) =>
          Effect.gen(function* () {
            const name = agent["~alchemy/Name"];
            const service = Context.getOption(
              registration.context,
              agent as any,
            );
            if (Option.isNone(service)) {
              return yield* Effect.die(
                `DriverCloudflare: no implementation provided for agent '${name}'`,
              );
            }
            return service.value as Actor;
          });

        // ── stance rendering (fragment tree → blocks + mentions) ─────
        const renderStance = (
          registration: RegisteredCharter,
          root: Fragment,
          tick: TickService,
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
                  if (isDispatchTool(ref)) {
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
                    const value = yield* provideRun(
                      ref as Effect.Effect<unknown>,
                      registration,
                      tick,
                    );
                    if (isFragment(value)) {
                      flush();
                      yield* walk(value);
                      flush();
                    } else if (isToolImpl(value)) {
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

        // ── the BURST: drain → tick → sample → append, until quiescent
        // Concurrent events (two HTTP requests, an alarm during a
        // dispatch) each kick a burst, so the loop is SERIALIZED: the
        // second waits, then finds its input already drained by the
        // first and returns at once. One serial loop per session is the
        // driver's contract, on this substrate too.
        const gate = yield* Semaphore.make(1);

        const burstOnce = Effect.gen(function* () {
          const registration = registrations.get(me.term);
          if (registration === undefined) {
            return yield* Effect.die(
              `DriverCloudflare: no charter registered for '${me.term}' — is its Layer in the worker's layers slot?`,
            );
          }

          // per-ACTIVATION init: the charter's closure is isolate
          // state (session-durable state lives in the thread/storage)
          let meta = yield* readMeta;

          // ── recovery: a busy marker on ENTRY means the previous
          // burst DIED mid-round — eviction, deploy, or crash, all
          // indistinguishable on disk and all re-entered the same way.
          // (The gate makes this unambiguous: a healthy predecessor
          // clears the marker before releasing.) Bounded re-entry:
          // progress resets the budget; exhaustion abandons the round
          // VISIBLY and the session keeps serving.
          let recovering = false;
          if (meta.busy !== undefined && meta.settled === undefined) {
            const attempts = meta.busy.attempts + 1;
            if (attempts > maxAttempts) {
              yield* appendThread([
                noteMessage(
                  `This round was interrupted ${maxAttempts} times and has been abandoned — the messages above it may be unanswered. Continuing fresh from here.`,
                ),
              ]);
              yield* observe({
                type: "input",
                text: `<note>\nround abandoned after ${maxAttempts} interrupted attempts\n</note>`,
                kind: "note",
              });
              meta = { ...(yield* readMeta), busy: undefined };
              yield* writeMeta(meta);
              const abandoned = new RoundAbandoned({
                term: me.term,
                key: me.key,
                attempts: maxAttempts,
              });
              yield* observe({
                type: "crashed",
                error: {
                  _tag: abandoned._tag,
                  message: abandoned.message,
                  retryable: false,
                },
                fatal: true,
              });
              // exhaustion is the ONE defect-lane crash that answers
              // waiters — as a TYPED failure the caller can catch,
              // never a silent undefined
              yield* failWaiters(abandoned);
            } else {
              meta = { ...meta, busy: { attempts, since: Date.now() } };
              yield* writeMeta(meta);
              yield* armAlarm;
              recovering = true;
              // INFORMED re-decision, without transcript surgery: the
              // interrupted attempt's tool calls never persisted (only
              // complete samplings append), so the re-sample would
              // otherwise repeat side effects blind. The note is the
              // cheap alternative to think's repaired tool parts —
              // appended at the TAIL, so the cached prefix stands.
              yield* appendThread([
                noteMessage(
                  `The previous attempt at this work was interrupted mid-sampling (attempt ${attempts} of ${maxAttempts}). Any actions it took may or may not have completed — verify before repeating anything with side effects.`,
                ),
              ]);
              yield* observe({
                type: "input",
                text: `<note>\nrecovering an interrupted round (attempt ${attempts}/${maxAttempts})\n</note>`,
                kind: "note",
              });
              yield* Effect.logInfo(
                `DriverCloudflare session '${me.term}/${me.key}': recovering an interrupted round (attempt ${attempts}/${maxAttempts})`,
              );
            }
          }

          const tickService = (count: number): TickService => ({
            count,
            say: (note) => Effect.sync(() => void pendingNotes.push(note)),
          });

          const initResult = yield* provideRun(
            registration.charter as Effect.Effect<unknown, unknown>,
            registration,
            tickService(meta.tick),
          ).pipe(Effect.orDie);
          const turn: Turn | TurnFn = isFragment(initResult)
            ? Effect.succeed(initResult)
            : (initResult as Turn | TurnFn);

          /**
           * Whether the LAST sampling was quiescent. An empty inbox is
           * only a park if it is — a sampling that called tools must
           * come back around to read their results, with no new input
           * at all. Starts `true` so a burst kicked with nothing to do
           * (its input already drained by the burst it queued behind)
           * parks instead of sampling — unless it is RECOVERING an
           * interrupted round, whose inputs are already in the thread
           * and owed a reply.
           */
          let quiescent = !recovering;
          // consecutive malformed-tool-call feedback rounds (see the
          // step catch below) — resets on any well-formed sampling
          let malformed = 0;

          while (true) {
            meta = yield* readMeta;
            if (meta.settled !== undefined) break;

            const rows = yield* listRows<unknown>(INBOX);
            // rows below the watermark were appended by an attempt
            // that died before deleting them — discard, never re-append
            const fresh = rows.filter(([k]) => seqOf(INBOX, k) >= meta.drained);
            if (fresh.length === 0 && quiescent) {
              if (rows.length > 0) {
                yield* storage.delete(rows.map(([k]) => k)).pipe(Effect.orDie);
              }
              // PARKED: the session's work is done until the world moves.
              // On this substrate parking is RETURNING — the next
              // event (deliver, steer, alarm) kicks a fresh burst.
              yield* observe({ type: "parked" });
              break;
            }
            // unwrap provenance envelopes: the thread and the turn's
            // `inputs` see plain values; the observation gets `kind`
            const drained = fresh.map(([, raw]) => inputProvenance(raw));
            const inputs = drained.map((item) => item.value);

            // append the inputs, advance the watermark, and OPEN the
            // round in ONE atomic write — only then delete the inbox
            // rows. Every crash point between redelivers into a state
            // that converges instead of losing or duplicating input.
            const entries: Record<string, unknown> = {};
            let seq = meta.seq;
            for (const input of inputs) {
              entries[seqKey(MSG, seq++)] = asUserMessage(input);
            }
            meta = {
              ...meta,
              seq,
              drained:
                fresh.length > 0
                  ? seqOf(INBOX, fresh[fresh.length - 1]![0]) + 1
                  : meta.drained,
              busy: meta.busy ?? { attempts: 0, since: Date.now() },
            };
            entries[META] = meta;
            yield* storage.put(entries).pipe(Effect.orDie);
            yield* armAlarm;
            if (rows.length > 0) {
              yield* storage.delete(rows.map(([k]) => k)).pipe(Effect.orDie);
            }
            for (const { value, kind } of drained) {
              yield* observe({
                type: "input",
                text: typeof value === "string" ? value : JSON.stringify(value),
                kind,
              });
            }

            // TICK — the stance for this sampling
            pendingNotes.length = 0;
            const tick = tickService(meta.tick);
            const result = yield* provideRun(
              Effect.suspend(() =>
                typeof turn === "function"
                  ? turn({ count: meta.tick, inputs })
                  : turn,
              ).pipe(
                Effect.retry({
                  while: (error) => !(error instanceof Refused),
                  schedule: Schedule.exponential("1 second"),
                  times: 3,
                }),
              ) as Effect.Effect<unknown>,
              registration,
              tick,
            );
            if (!isFragment(result)) {
              return yield* Effect.die(
                `DriverCloudflare: the turn of '${me.term}' returned a non-Fragment — turns return the stance; answer callers with AI.reply`,
              );
            }
            const stance = yield* renderStance(registration, result, tick);

            // notes (`AI.say`) — a plain append, in emission order
            const notes: Array<Prompt.MessageEncoded> = [];
            for (const note of pendingNotes.splice(0)) {
              const text = render(note.template as TemplateStringsArray, [
                ...note.refs,
              ]);
              if (text.length === 0) continue;
              notes.push(noteMessage(text));
              yield* observe({
                type: "input",
                text: `<note>\n${text}\n</note>`,
                kind: "note",
              });
            }
            yield* appendThread(notes);

            // the toolkit: charter tools + active skills + doors + intrinsics
            const handlers: Record<
              string,
              (params: any) => Effect.Effect<any, any, any>
            > = {};
            const tools: Array<AiTool.Any> = [];
            for (const [name, compiled] of stance.tools) {
              tools.push(compileTool(compiled.term));
              const resolved = yield* resolveHandler(registration, compiled);
              handlers[name] = (params: any) =>
                provideRun(resolved(params), registration, tick);
            }
            for (const [name, door] of stance.doors) {
              tools.push(compileTool(door as never));
              handlers[name] = (params: any) =>
                Effect.gen(function* () {
                  const derived = yield* door.policy(params, { key: me.key });
                  const actor = yield* resolveDelegate(
                    registration,
                    door.agent,
                  );
                  const agentName = door.agent["~alchemy/Name"];
                  if (derived.key !== undefined) {
                    children.set(`${agentName}:${derived.key}`, {
                      term: agentName,
                      key: derived.key,
                    });
                  }
                  yield* observe({
                    type: "dispatched",
                    tick: meta.tick,
                    toolName: name,
                    agent: agentName,
                    child: derived.key,
                  });
                  return yield* actor
                    .dispatch(derived.task, {
                      key: derived.key,
                      parent: { term: me.term, key: me.key },
                    })
                    .pipe(Effect.provide(RuntimeContext.phantom));
                });
            }
            const delegates = new Map<string, Actor>();
            for (const [name, agent] of stance.delegates) {
              delegates.set(name, yield* resolveDelegate(registration, agent));
            }
            if (delegates.size > 0) {
              tools.push(compileDispatch([...delegates.keys()]));
              handlers.dispatch = (params: {
                agent: string;
                task: string;
                session?: string;
              }) =>
                Effect.gen(function* () {
                  const actor = delegates.get(params.agent)!;
                  const childKey =
                    params.session === undefined
                      ? undefined
                      : `${me.key}/${params.agent}/${params.session}`;
                  if (childKey !== undefined) {
                    children.set(`${params.agent}:${childKey}`, {
                      term: params.agent,
                      key: childKey,
                    });
                  }
                  yield* observe({
                    type: "dispatched",
                    tick: meta.tick,
                    toolName: "dispatch",
                    agent: params.agent,
                    child: childKey,
                  });
                  const answer = yield* actor
                    .dispatch(params.task, {
                      key: childKey,
                      parent: { term: me.term, key: me.key },
                    })
                    .pipe(Effect.provide(RuntimeContext.phantom));
                  // a child's round can run for minutes; the answer
                  // arriving is the fact worth a breadcrumb, since a
                  // deployed session can only be read through its logs
                  yield* Effect.logDebug(
                    `[dispatch] ${params.agent} answered ${JSON.stringify(answer)?.slice(0, 120)}`,
                  );
                  return answer;
                });
            }
            if (stance.skills.size > 0) {
              tools.push(compileSkillTool([...stance.skills.keys()]));
              handlers.skill = (params: {
                action: "activate" | "deactivate";
                skill: string;
              }) =>
                Effect.gen(function* () {
                  const current = yield* readMeta;
                  const active = new Set(current.active);
                  if (params.action === "deactivate") {
                    active.delete(params.skill);
                    yield* writeMeta({ ...current, active: [...active] });
                    return `deactivated ${params.skill}`;
                  }
                  const skillTerm = stance.skills.get(params.skill);
                  if (skillTerm === undefined) {
                    return `no skill named '${params.skill}' is available right now`;
                  }
                  const resolved = yield* resolveSkill(registration, skillTerm);
                  active.add(params.skill);
                  yield* writeMeta({ ...current, active: [...active] });
                  return resolved.prose;
                });
            }
            // ACTIVE skills contribute their tools to this tick
            for (const name of meta.active) {
              const skillTerm = stance.skills.get(name);
              if (skillTerm === undefined) continue; // not reachable now
              const resolved = yield* resolveSkill(registration, skillTerm);
              tools.push(...resolved.tools);
              for (const [toolName, fn] of Object.entries(resolved.handlers)) {
                handlers[toolName] ??= (params: any) =>
                  provideRun(fn(params), registration, tick);
              }
            }
            tools.push(
              compileSpawn([...stance.tools.keys()], [...stance.skills.keys()]),
            );
            handlers.spawn = () =>
              // v1: anonymous workers are not yet hosted on this
              // substrate (each would be its own DO session) — the model
              // sees an honest refusal rather than a silent no-op
              Effect.succeed(
                "spawn is not available on this driver yet — do the work yourself or dispatch a named agent",
              );

            const system = stance.blocks.join("\n\n") + NOTE_CODA;
            // handlers run INSIDE the DO's event, so the runtime
            // capability is already satisfied — seal it once here
            const toolkit = yield* buildToolkit(dedupeByName(tools), handlers, {
              wrapHandler: (handler) => (params) =>
                Effect.provide(
                  handler(params),
                  RuntimeContext.phantom,
                ) as Effect.Effect<any, any>,
            });

            const thread = yield* readThread;
            const startedAt = Date.now();
            const response = yield* model
              .step({
                prompt: Prompt.concat(
                  Prompt.make([{ role: "system", content: system }]),
                  thread,
                ),
                toolkit,
                onLive: (part) =>
                  sealed(
                    part.kind === "tool-call"
                      ? observeLive({
                          type: "tool-call",
                          tick: meta.tick,
                          toolCallId: part.id,
                          toolName: part.name,
                          input: part.params,
                        })
                      : observeLive({
                          type: "assistant-delta",
                          tick: meta.tick,
                          channel: part.kind,
                          delta: part.delta,
                        }),
                  ),
              })
              .pipe(
                // A MALFORMED TOOL CALL is a model-visible fact, not a
                // crash: nothing was executed, so tell the model what
                // was wrong and let it re-issue. Bounded — a model that
                // keeps emitting invalid calls crashes with the real
                // error after the model's streak budget.
                Effect.catchIf(
                  (error): error is AiError =>
                    isAiError(error) &&
                    error.reason._tag === "ToolParameterValidationError",
                  (error) =>
                    malformed >= model.malformedBudget
                      ? Effect.fail(error)
                      : Effect.succeed({ malformed: error.message } as const),
                ),
              );
            if ("malformed" in response) {
              malformed++;
              const text =
                `your last response included a tool call with INVALID ` +
                `parameters — NOTHING was executed:\n${response.malformed}\n` +
                `Re-issue the call with parameters matching the tool's schema.`;
              yield* appendThread([noteMessage(text)]);
              yield* observe({
                type: "input",
                text: `<note>\n${text}\n</note>`,
                kind: "note",
              });
              quiescent = false; // come straight back around and re-sample
              continue;
            }
            malformed = 0;

            yield* appendThread(
              encodeMessages(
                Prompt.fromResponseParts(response.content).content,
              ),
            );
            yield* observe({
              type: "assistant",
              tick: meta.tick,
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
              yield* observe({
                type: "tool-result",
                toolCallId: result.id,
                toolName: result.name,
                output: result.result,
                isFailure: result.isFailure,
              });
            }
            quiescent = response.toolCalls.length === 0;
            meta = yield* readMeta;
            yield* writeMeta({
              ...meta,
              tick: meta.tick + 1,
              // PROGRESS: a completed sampling resets the recovery
              // budget; a quiescent one closes the round entirely
              busy: quiescent ? undefined : { attempts: 0, since: Date.now() },
            });

            if (quiescent) {
              // the round's remaining waiters answer with the text —
              // the loop comes around once more and parks there
              yield* resolveWaiters(response.text);
            } else {
              yield* armAlarm;
            }
          }
        }).pipe(
          Effect.tapCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logError(
                `DriverCloudflare session '${me.term}/${me.key}' crashed`,
                cause,
              );
              const crash = describeCrash(cause);
              yield* observe({
                type: "crashed",
                error: crash.encoded,
                fatal: !crash.encoded.retryable,
              });
              const meta = yield* readMeta;
              if (!crash.encoded.retryable) {
                // DETERMINISTIC failure (billing, auth, content policy):
                // recovery would replay the identical error — abandon the
                // round NOW, fail waiters with the ORIGINAL typed error
                // (catchable by tag), and keep serving: the next event
                // opens a fresh round.
                const line =
                  crash.encoded._tag !== undefined
                    ? `${crash.encoded._tag}: ${crash.encoded.message}`
                    : crash.encoded.message;
                yield* appendThread([
                  noteMessage(
                    `The previous round failed with a non-retryable error ` +
                      `(${line}) and was abandoned rather than retried. ` +
                      `The messages above it may be unanswered.`,
                  ),
                ]);
                yield* writeMeta({ ...meta, busy: undefined });
                yield* failWaiters(crash.error);
                yield* armAlarm;
                return;
              }
              // do NOT answer waiters: the round is still OWED —
              // recovery re-enters (the alarm, or any event) and
              // answers them at quiescence; exhaustion is the only
              // crash that fails them. What we MUST guarantee here is
              // that the wake is coming: a crash before the drain
              // opened the round would otherwise leave no alarm armed
              // and a caller parked forever.
              if (meta.busy === undefined && meta.settled === undefined) {
                yield* writeMeta({
                  ...meta,
                  busy: { attempts: 0, since: Date.now() },
                });
              }
              yield* armAlarm;
            }),
          ),
        );

        const burst = gate.withPermits(1)(burstOnce);

        const enqueue = (input: unknown) =>
          Effect.gen(function* () {
            const meta = yield* readMeta;
            // one atomic write: a crash can never leave a row the
            // counter would overwrite
            yield* storage
              .put({
                [seqKey(INBOX, meta.seq)]: input,
                [META]: { ...meta, seq: meta.seq + 1 },
              })
              .pipe(Effect.orDie);
          });

        return Effect.succeed<SessionRpc>({
          /**
           * The LIVE VIEW attaches here (via {@link AgentGateway}):
           * accept the WebSocket and hibernate freely — there is no
           * in-memory session state to lose, because `broadcast`
           * re-reads the attached sockets from the runtime every time.
           */
          fetch: Effect.gen(function* () {
            const [response] = yield* upgrade();
            return response;
          }),
          webSocketMessage: (socket, message) =>
            Effect.suspend(() =>
              handleSessionSocketFrame(
                {
                  replay: (fromSeq) =>
                    sealed(
                      Effect.map(listRows<SessionObservation>(OBS), (rows) =>
                        rows.flatMap(([k, observation]) =>
                          seqOf(OBS, k) >= fromSeq ? [observation] : [],
                        ),
                      ),
                    ),
                  watermark: sealed(
                    Effect.map(readMeta, (meta) => meta.observed),
                  ),
                  // the socket's steer: admit input; the answer
                  // arrives as observations, never as a response
                  submit: (input) =>
                    sealed(
                      Effect.gen(function* () {
                        const meta = yield* readMeta;
                        if (meta.settled !== undefined) return;
                        if (meta.tick === 0 && meta.seq === 0) {
                          yield* observe({ type: "admitted" });
                        }
                        yield* enqueue(input);
                        yield* state.waitUntil(burst);
                      }),
                    ),
                },
                (frame) => Effect.ignore(socket.send(JSON.stringify(frame))),
              )(
                JSON.parse(
                  typeof message === "string"
                    ? message
                    : new TextDecoder().decode(message),
                ) as SessionSocketClientFrame,
              ),
            ).pipe(
              // a malformed frame must never kill the socket's DO
              Effect.catchDefect((defect) =>
                Effect.logWarning(`[session-socket] bad frame: ${defect}`),
              ),
              Effect.provide(RuntimeContext.phantom),
            ) as Effect.Effect<void>,
          webSocketClose: (socket, code, reason) =>
            Effect.ignore(socket.close(code, reason)),
          deliver: (
            input: unknown,
            options?: { parent?: SessionRef; wake?: boolean },
          ) =>
            Effect.gen(function* () {
              const meta = yield* readMeta;
              if (meta.settled !== undefined) return;
              if (meta.tick === 0 && meta.seq === 0) {
                yield* observe({ type: "admitted", parent: options?.parent });
              }
              yield* enqueue(input);
              // QUIET delivery (`wake: false`): the row is durable in
              // the inbox but no burst is kicked — a parked session stays
              // parked, and whatever wakes it next (a waking send, a
              // reminder, an operator steer) drains everything
              // accumulated. A session that is ALREADY bursting picks the
              // row up at its next boundary regardless.
              if (options?.wake !== false) {
                yield* state.waitUntil(burst);
              }
            }),
          dispatch: (input: unknown, options?: { parent?: SessionRef }) =>
            Effect.gen(function* () {
              const meta = yield* readMeta;
              if (meta.settled !== undefined) return meta.settled.outcome;
              if (meta.tick === 0 && meta.seq === 0) {
                yield* observe({ type: "admitted", parent: options?.parent });
              }
              const waiter = yield* Deferred.make<unknown, unknown>();
              yield* enqueue(input);
              waiters.push(waiter);
              // waitUntil, NOT forkChild: `AI.reply` answers this RPC
              // mid-round and the model keeps working afterwards, so
              // the loop must outlive the call that started it
              yield* state.waitUntil(burst);
              return yield* Deferred.await(waiter);
            }),
          steer: (input: unknown) =>
            Effect.gen(function* () {
              const meta = yield* readMeta;
              if (meta.settled !== undefined) return;
              yield* enqueue(input);
              yield* state.waitUntil(burst);
            }),
          settle: (
            outcome: unknown,
          ): Effect.Effect<void, never, RuntimeContext> =>
            Effect.gen(function* () {
              const meta = yield* readMeta;
              if (meta.settled !== undefined) return;
              // busy dies with the session — a settled session must not keep
              // an armed recovery alarm re-entering it
              yield* writeMeta({
                ...meta,
                settled: { outcome },
                busy: undefined,
              });
              yield* observe({ type: "settled" });
              yield* resolveWaiters(outcome);
              // the SUPERVISION cascade, cross-DO: a supervisor's end
              // ends the session workers it opened
              for (const child of children.values()) {
                yield* Effect.ignore(
                  sessions
                    .getByName(sessionName(child.term, child.key))
                    .settle({ supervisor: { term: me.term, key: me.key } }),
                );
              }
              children.clear();
            }),
          /**
           * The single alarm serves BOTH clocks: due reminders become
           * ordinary inputs, and an open round's recovery deadline
           * re-enters the burst. Re-arming happens AFTER the burst so
           * the alarm reflects the round's final state — and a failing
           * burst is contained rather than failing the alarm event,
           * because workerd's own alarm retry would race our bounded
           * one (and give up for good after its budget).
           */
          alarm: () =>
            Effect.gen(function* () {
              const now = Date.now();
              const rows = yield* listRows<string>(REMIND);
              const due = rows.filter(([k]) => seqOf(REMIND, k) <= now);
              for (const [, note] of due) {
                yield* enqueue(reminderInput(note));
              }
              if (due.length > 0) {
                yield* storage.delete(due.map(([k]) => k)).pipe(Effect.orDie);
              }
              yield* Effect.exit(burst);
              yield* armAlarm;
            }),
        });
      }),
    );
    let minted = 0;
    const mintPrefix = crypto.randomUUID().slice(0, 8);

    const interpret = (term: Interpretable, charter: Charter) =>
      Effect.gen(function* () {
        const termName = term["~alchemy/Name"];
        registrations.set(termName, {
          charter,
          context: yield* Effect.context<never>(),
          term,
        });

        const stub = (key: string) =>
          sessions.getByName(sessionName(termName, key));
        const mint = () => `session-${mintPrefix}-${minted++}`;

        return {
          send: (item: unknown, options?: Parameters<Actor["send"]>[1]) =>
            stub(options?.key ?? mint())
              .deliver(item, { parent: options?.parent, wake: options?.wake })
              .pipe(Effect.orDie, Effect.asVoid),
          dispatch: (
            item: unknown,
            options?: Parameters<Actor["dispatch"]>[1],
          ) =>
            stub(options?.key ?? mint())
              .dispatch(item, { parent: options?.parent })
              .pipe(Effect.orDie),
          steer: ((first: unknown, second?: unknown) =>
            second === undefined
              ? Effect.die(
                  new Error(
                    "DriverCloudflare: steer requires a key — steer(key, input)",
                  ),
                )
              : stub(first as string)
                  .steer(second)
                  .pipe(Effect.orDie, Effect.asVoid)) as Actor["steer"],
          settle: (sessionKey: string, outcome: unknown) =>
            stub(sessionKey).settle(outcome).pipe(Effect.orDie, Effect.asVoid),
          interrupt: () =>
            Effect.die(
              new Error(
                "DriverCloudflare: interrupt() is process-local; settle sessions by key instead",
              ),
            ),
        } as Actor;
      }) as Effect.Effect<Actor, DriverError, never>;

    /** The gateway: route a WebSocket upgrade into the session's own DO. */
    const attach = (
      term: string,
      key: string,
      request: HttpServerRequest.HttpServerRequest,
    ) =>
      sessions
        .getByName(sessionName(term, key))
        .fetch(request)
        .pipe(Effect.orDie) as Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        never,
        RuntimeContext
      >;

    return Context.add(Context.make(Driver, { interpret }), AgentGateway, {
      attach,
    });
  }),
);
