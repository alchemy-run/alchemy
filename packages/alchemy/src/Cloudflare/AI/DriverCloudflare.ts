/**
 * The DURABLE OBJECT HOST — the same `AI.Driver` contract as
 * `AI.DriverCore`, with sessions hosted on Durable Objects: ONE DO
 * instance per session (named `${term}/${key}`), the thread and inbox
 * in DO storage, `Thread.remind` on the DO alarm, actor verbs as RPC.
 *
 * The ALGORITHM is not here: turn evaluation, stance rendering, the
 * skill graph, toolkit assembly, and sampling are the shared
 * `compileTick`/`sampleTick` from `AI/DriverShared` — the same code
 * the resident host (`AI.DriverCore`) runs. This module contributes
 * what the substrate forces:
 *
 * - {@link DurableObjectSessionStorage} (`DurableObjectThreadStorage`)
 *   — the shared `ThreadHandle` contract over the DO's own rows.
 * - the BURST execution shape: no resident fiber exists; each event
 *   (RPC, socket frame, alarm) kicks a serialized burst that runs
 *   rounds until quiescence and RETURNS — parking is returning.
 * - crash RECOVERY: a liveness marker opens with each round and an
 *   alarm re-enters interrupted rounds, bounded by attempts.
 *
 * Swapping substrates is one line:
 *
 * ```ts
 * const OrgAgents = Layer.mergeAll(IssueOwnerLive, EngineerLayer).pipe(
 *   Layer.provideMerge(Cloudflare.AI.DriverCloudflare),  // ← or AI.DriverCore + a ThreadStorage
 *   Layer.provideMerge(Model),
 * );
 * ```
 *
 * ## How a charter reaches the DO
 *
 * A charter is CODE and cannot cross the wire — and it doesn't need
 * to: the Worker and its DO classes share ONE memoized layer build per
 * isolate (`WorkerBridge.getSharedBuild`), and the class-level
 * `layers` slot IS that build. So the agent layers build on the DO
 * side too, their `interpret` calls record `term → {charter, captured
 * context}` in this driver's registrations, and the `AgentSessions`
 * DO — declared here, discovered as a binding because the layer
 * yields it during init — closes over that same map. An activating DO
 * parses its own name and becomes that session.
 *
 * Because the actor verbs are uniform, a door fired INSIDE a session
 * RPCs to the delegate's own DO: cross-session delegation is cross-DO
 * by construction.
 */
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Prompt from "effect/unstable/ai/Prompt";
import type { Actor, SessionRef } from "../../AI/Actor.ts";
import {
  Driver,
  type Charter,
  type Interpretable,
  type Turn,
  type TurnFn,
} from "../../AI/Driver.ts";
import {
  applyCompactionPlan,
  asUserMessage,
  compileTick,
  describeCrash,
  inputProvenance,
  makeResolvers,
  noteMessage,
  reminderInput,
  render,
  sampleTick,
  type ObservationDraft,
  type SessionOps,
  type Stance,
} from "../../AI/DriverShared.ts";
import type { DriverError } from "../../AI/Errors.ts";
import { makeModel, Model } from "../../AI/Model.ts";
import {
  SessionObserver,
  RoundAbandoned,
  type SessionObservation,
} from "../../AI/Observer.ts";
import * as PersistentRef from "../../PersistentRef.ts";
import { makeDurableObjectStore } from "../Workers/PersistentRefStore.ts";
import { isFragment, type Fragment } from "../../AI/Prose.ts";
import {
  AgentGateway,
  handleSessionSocketFrame,
  type SessionSocketClientFrame,
  type SessionSocketServerFrame,
} from "../../AI/SessionSocket.ts";
import {
  Thread,
  Tick,
  type CompactPlan,
  type ThreadService,
  type TickService,
} from "../../AI/Thread.ts";
import type { HttpEffect } from "../../Http.ts";
import type { MainRpc } from "../../Platform.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import { DurableObject } from "../Workers/DurableObject.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import { upgrade, type WebSocket } from "../Workers/WebSocket.ts";
import { Worker } from "../Workers/Worker.ts";
import {
  INBOX,
  META,
  MSG,
  REMIND,
  makeDurableObjectSessionStorage,
  seqKey,
  seqOf,
  type DurableSessionMeta,
} from "./DurableObjectThreadStorage.ts";

/** What one `interpret` call recorded — all the session engine needs
 *  to BECOME a session of this term when a DO activates. */
interface RegisteredCharter {
  readonly charter: Charter;
  /** The charter's own Layer graph, captured at interpret — tools,
   *  doors, and delegates resolve from it as on the resident host. */
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

/**
 * A session's RPC surface — the {@link Actor} verbs, as one DO speaks
 * them. Uniform across every agent, which is what makes delegation
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
 * difference from `AI.DriverCore`'s `Layer<Driver, never,
 * LanguageModel | ThreadStorage>` — the substrate is in the type.
 */
export const DurableObjectHost: Layer.Layer<
  Driver | AgentGateway,
  never,
  LanguageModel.LanguageModel | Worker
> = Layer.effectContext(
  Effect.gen(function* () {
    const languageModel = yield* LanguageModel.LanguageModel;
    const registrations = new Map<string, RegisteredCharter>();

    /**
     * The sessions namespace: ONE Durable Object for every agent — the
     * term prefix of the instance name says which charter an
     * activation becomes. Declared HERE, not by the user, and closed
     * over `registrations`, which the shared layer build populates
     * before any activation's constructor runs.
     */
    const sessions = yield* DurableObject<SessionRpc>()(
      "AgentSessions",
      Effect.gen(function* () {
        const state = yield* DurableObjectState;
        const storage = state.storage;
        const store = makeDurableObjectSessionStorage(state);
        const { readMeta, writeMeta, listRows, appendThread, handle } = store;
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

        // ── the optional seams, from the captured build context ─────
        const captured = yield* Effect.context<never>();
        const observer = Context.getOption(captured, SessionObserver);
        const durability = Option.getOrElse(
          Context.getOption(captured, DriverDurability),
          () => ({}) as (typeof DriverDurability)["Service"],
        );
        const recoverAfter = durability.recoverAfterMillis ?? 30_000;
        const maxAttempts = durability.maxAttempts ?? 5;
        // the MODEL seam: a user driver provides its own (retry,
        // budget, and tiering policy live inside it); absent, the
        // default over this driver's LanguageModel.
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
         * this session's own projection) with the cursor bump in ONE
         * atomic write, then fanned out to attached sockets and the
         * external observer. The row is the record; delivery is
         * best-effort on both channels.
         */
        const observe = (observation: ObservationDraft) =>
          Effect.gen(function* () {
            const meta = yield* readMeta;
            const full = {
              ...observation,
              term: me.term,
              key: me.key,
              seq: meta.observed,
              at: Date.now(),
            } as SessionObservation;
            yield* handle.appendObservation(full, {
              tick: meta.tick,
              observed: meta.observed + 1,
              active: meta.active,
            });
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
        const observeLive = (observation: ObservationDraft) =>
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
        const children = new Map<
          string,
          { readonly key: string; readonly actor: Actor }
        >();
        /** The last rendered stance — what `skill` grants from. */
        let lastStance: Stance | undefined;
        /** Requested compaction; applied at the next round boundary.
         *  Isolate-scoped on purpose: a lost plan costs one compaction,
         *  never correctness. */
        let pendingCompaction: CompactPlan | undefined;

        const resolveWaiters = (value: unknown) =>
          Effect.forEach(waiters.splice(0), (w) => Deferred.succeed(w, value), {
            discard: true,
          });
        const failWaiters = (error: unknown) =>
          Effect.forEach(waiters.splice(0), (w) => Deferred.fail(w, error), {
            discard: true,
          });

        // ── the session-scoped AI.Thread / AI.Tick services ─────────
        // storage is a RUNTIME capability; the session-scoped services
        // the driver hands userland are plain effects, so seal it here
        const sealed = <A>(
          effect: Effect.Effect<A, never, RuntimeContext>,
        ): Effect.Effect<A> => Effect.provide(effect, RuntimeContext.phantom);

        const threadService: ThreadService = {
          get key() {
            return me.key;
          },
          tokens: sealed(
            Effect.map(handle.messages, (rows) =>
              Math.ceil(JSON.stringify(rows).length / 4),
            ) as Effect.Effect<number, never, RuntimeContext>,
          ),
          entries: sealed(
            Effect.map(
              handle.messages,
              (rows) => Prompt.make([...rows]).content,
            ) as Effect.Effect<any, never, RuntimeContext>,
          ),
          // recorded now, applied at the next round boundary — same
          // contract as the resident host
          compact: (plan) =>
            Effect.sync(() => {
              pendingCompaction = plan;
            }),
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
         * The session's `PersistentRef.Store`: DO storage rows under
         * the session's own prefix, written through the synchronous KV
         * API — write coalescing + the output gate make writes durable
         * before anything leaves the DO. ONE instance per activation:
         * `PersistentRef` memoizes refs per store instance, so every
         * `make` of a name within this activation shares one in-memory
         * cache. Building the object only captures `state`; storage is
         * touched lazily.
         */
        const stateStore = makeDurableObjectStore(state);

        const provideSession = <A, E>(
          effect: Effect.Effect<A, E, any>,
          registration: RegisteredCharter,
          tick: TickService,
        ): Effect.Effect<A, E> =>
          effect.pipe(
            Effect.provideService(Thread, threadService),
            Effect.provideService(Tick, tick),
            Effect.provideService(PersistentRef.Store, stateStore),
            // The FRAME: every ref this session makes is namespaced by
            // the session's durable identity, so isolation is a logical
            // property of the key — not an accident of this store
            // being per-DO — and survives a swap to a shared store.
            PersistentRef.within(me.term, me.key),
            Effect.provide(RuntimeContext.phantom),
            Effect.provide(registration.context),
          ) as Effect.Effect<A, E>;

        /** Apply a requested compaction at the round boundary —
         *  the shared plan application over this session's handle. */
        const applyCompaction = Effect.suspend(() => {
          const plan = pendingCompaction;
          if (plan === undefined) return Effect.void;
          pendingCompaction = undefined;
          return applyCompactionPlan(handle, plan);
        });

        // ── the BURST: drain → tick → sample → append, until quiescent
        // Concurrent events (two HTTP requests, an alarm during a
        // dispatch) each kick a burst, so the loop is SERIALIZED: the
        // second waits, then finds its input already drained by the
        // first and returns at once. One serial loop per session is
        // the driver's contract, on this substrate too.
        const gate = yield* Semaphore.make(1);

        const burstOnce = Effect.gen(function* () {
          const registration = registrations.get(me.term);
          if (registration === undefined) {
            return yield* Effect.die(
              `DriverCloudflare: no charter registered for '${me.term}' — is its Layer in the worker's layers slot?`,
            );
          }
          const resolvers = makeResolvers(
            "DriverCloudflare",
            me.term,
            registration.context,
          );

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

          let tickCount = meta.tick;
          /** Skills activated so far — refreshed from meta per round. */
          let activeSkills = new Set(meta.active);

          const tickService = (count: number): TickService => ({
            count,
            say: (note) => Effect.sync(() => void pendingNotes.push(note)),
          });

          const initResult = yield* provideSession(
            registration.charter as Effect.Effect<unknown, unknown>,
            registration,
            tickService(meta.tick),
          ).pipe(Effect.orDie);
          const turn: Turn | TurnFn = isFragment(initResult)
            ? Effect.succeed(initResult)
            : (initResult as Turn | TurnFn);

          /** The host adapter the shared algorithm consumes — this
           *  host backs it with the DO's storage and isolate state. */
          const ops: SessionOps = {
            driver: "DriverCloudflare",
            term: me.term,
            key: me.key,
            context: registration.context,
            provide: (effect) =>
              provideSession(effect, registration, tickService(tickCount)),
            turn: () => turn,
            tick: () => tickCount,
            clearNotes: () => {
              pendingNotes.length = 0;
            },
            // sealed: the shared algorithm's observation sites run
            // inside a DO event, where the capability is satisfied
            observe: (draft) => sealed(observe(draft)),
            observeLive: (draft) => sealed(observeLive(draft)),
            activeSkills: () => activeSkills,
            setSkill: (name, active) =>
              sealed(
                Effect.gen(function* () {
                  const current = yield* readMeta;
                  const next = new Set(current.active);
                  if (active) next.add(name);
                  else next.delete(name);
                  activeSkills = next;
                  yield* writeMeta({ ...current, active: [...next] });
                }),
              ),
            lastStance: () => lastStance,
            setLastStance: (stance) => {
              lastStance = stance;
            },
            registerChild: (agent, childKey, actor) => {
              children.set(`${agent}:${childKey}`, { key: childKey, actor });
            },
            spawn: () =>
              // v1: anonymous workers are not yet hosted on this
              // substrate (each would be its own DO session) — the
              // model sees an honest refusal rather than a silent no-op
              Effect.succeed(
                "spawn is not available on this driver yet — do the work yourself or dispatch a named agent",
              ),
            wrapHandler: (handler) => (params) =>
              Effect.provide(
                handler(params),
                RuntimeContext.phantom,
              ) as Effect.Effect<any, any>,
          };

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
          // consecutive malformed-tool-call feedback rounds — resets
          // on any well-formed sampling
          let malformed = 0;

          while (true) {
            meta = yield* readMeta;
            tickCount = meta.tick;
            activeSkills = new Set(meta.active);
            if (meta.settled !== undefined) break;

            const rows = yield* listRows<unknown>(INBOX);
            // rows below the watermark were appended by an attempt
            // that died before deleting them — discard, never re-append
            const fresh = rows.filter(([k]) => seqOf(INBOX, k) >= meta.drained);
            if (fresh.length === 0 && quiescent) {
              if (rows.length > 0) {
                yield* storage.delete(rows.map(([k]) => k)).pipe(Effect.orDie);
              }
              // PARKED: the session's work is done until the world
              // moves. On this substrate parking is RETURNING — the
              // next event (deliver, steer, alarm) kicks a fresh burst.
              yield* observe({ type: "parked" });
              break;
            }
            // boundary work: requested compaction applies BEFORE the
            // new inputs join the thread, so nothing fresh is lost
            yield* applyCompaction;
            // unwrap provenance envelopes: the thread and the turn's
            // `inputs` see plain values; the observation gets `kind`
            const drained = fresh.map(([, raw]) => inputProvenance(raw));
            const inputs = drained.map((item) => item.value);

            // append the inputs, advance the watermark, and OPEN the
            // round in ONE atomic write — only then delete the inbox
            // rows. Every crash point between redelivers into a state
            // that converges instead of losing or duplicating input.
            meta = yield* readMeta;
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
            entries[META] = meta satisfies DurableSessionMeta;
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

            // TICK — the shared algorithm renders this sampling's
            // stance and assembles its toolkit
            const tick = yield* compileTick(ops, resolvers, inputs);

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

            const outcome = yield* sampleTick({
              ops,
              model,
              handle,
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
            quiescent = response.toolCalls.length === 0;
            meta = yield* readMeta;
            yield* writeMeta({
              ...meta,
              tick: meta.tick + 1,
              // PROGRESS: a completed sampling resets the recovery
              // budget; a quiescent one closes the round entirely
              busy: quiescent ? undefined : { attempts: 0, since: Date.now() },
            });
            tickCount = meta.tick + 1;

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
                [META]: {
                  ...meta,
                  seq: meta.seq + 1,
                } satisfies DurableSessionMeta,
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
                  replay: (fromSeq) => sealed(handle.observations(fromSeq)),
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
              // the inbox but no burst is kicked — a parked session
              // stays parked, and whatever wakes it next (a waking
              // send, a reminder, an operator steer) drains everything
              // accumulated. A session that is ALREADY bursting picks
              // the row up at its next boundary regardless.
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
              // busy dies with the session — a settled session must
              // not keep an armed recovery alarm re-entering it
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
                  child.actor
                    .settle(child.key, {
                      supervisor: { term: me.term, key: me.key },
                    })
                    .pipe(Effect.provide(RuntimeContext.phantom)),
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

    /** The gateway: route a WebSocket upgrade into the session's own
     *  DO. */
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

/**
 * The composed Cloudflare driver: the Durable Object HOST over the
 * Durable Object THREAD STORAGE — one name for the assembly most
 * Workers want.
 */
export const DriverCloudflare = DurableObjectHost;
