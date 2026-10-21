import type * as Aggregate from "@alchemy.run/domain/Aggregate";
import { isAfter, mergeCheckpoints } from "@alchemy.run/domain/InMemory";
import { captureContext } from "@alchemy.run/domain/internal";
import {
  type Accepted,
  type AggregateKit,
  type Delivery,
  emptySnapshot,
  emptyStreamMeta,
  Platform,
  type Json,
  type PolicyKit,
  type ProjectionKit,
  type Push,
  type SendResult,
  type StoredEvent,
  type StreamEntry,
  type StreamKit,
  type StreamMeta,
  type StreamWrite,
  type Subscription,
  type ViewEntry,
  type ViewKit,
  type ViewSnapshot,
} from "@alchemy.run/domain/Platform";
import { makeCallback } from "alchemy/Callback";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { WorkflowEngine } from "effect/workflow";
import { DurableObject as CloudflareDurableObject } from "../Workers/DurableObject.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import { upgrade, type WebSocket } from "../Workers/WebSocket.ts";
import type { Worker } from "../Workers/Worker.ts";
import { DurableObjectEngine } from "../Workflows/DurableObjectEngine.ts";

const pad = (n: number) => n.toString().padStart(12, "0");

const DefectTag = "alchemy/Domain/Defect";

/**
 * Workers RPC replaces thrown errors with an opaque "internal error". Return
 * failures as data instead, and rethrow them as defects on the calling side.
 */
const reportDefects = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({ [DefectTag]: Cause.pretty(cause) } as unknown as A),
    ),
  );

/**
 * How long to keep retrying a Durable Object call that failed in transit:
 * an instance being reset reports an opaque "internal error", and for a while
 * after a deploy some instances still run the previous script (whose classes
 * "do not implement" our methods). Backs off from 100ms to 2s, about a minute
 * in total, so a call survives a deploy's rollout.
 */
const TRANSIT_RETRY = {
  // Whichever delay is shorter: exponential at first, then every 2 seconds.
  schedule: Schedule.min([Schedule.exponential("100 millis"), Schedule.spaced("2 seconds")]),
  times: 35,
} as const;

/**
 * Call a Durable Object. A call that fails in transit is retried: every Domain
 * object method is idempotent (sends dedupe by command id, deliveries by
 * checkpoint, schedules replace, reads are reads). A defect the object
 * reported, or a call that keeps failing, is a defect for the caller.
 */
const unwrapDefects = <A>(call: Effect.Effect<unknown, unknown>): Effect.Effect<A> =>
  call.pipe(
    Effect.catchDefect((defect) => Effect.fail(defect)),
    Effect.retry(TRANSIT_RETRY),
    Effect.catch((error) => Effect.die(error)),
    Effect.flatMap((value) =>
      value !== null && typeof value === "object" && DefectTag in value
        ? Effect.die(new Error(String((value as Record<string, unknown>)[DefectTag])))
        : Effect.succeed(value as A),
    ),
  );

/** A Durable Object stub: every method is an RPC returning an Effect. */
interface Stub {
  readonly [method: string]: (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>;
}

interface Namespace {
  readonly getByName: (name: string) => Stub & {
    readonly fetch: (
      request: HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>;
  };
}

/** What an instance's methods and constructor run with. */
type InstanceServices = DurableObjectState | RuntimeContext | Scope.Scope;

/** The usual outer (construction) / inner (instance) pair. */
type ObjectImpl = Effect.Effect<
  Effect.Effect<Record<string, unknown>, never, InstanceServices>,
  never,
  DurableObjectState
>;

/**
 * Declare a Durable Object class on the host Worker from inside a factory.
 * The inline form of `Cloudflare.DurableObject` is typed for single-stage
 * implementations, so it is re-typed here for the two-stage form it runs.
 */
const declare = CloudflareDurableObject as unknown as (
  name: string,
  impl: ObjectImpl,
) => Effect.Effect<Namespace, never, Worker>;

/**
 * Run `effect` with every other event on this instance held back. Durable
 * Objects run each event in its own I/O context, so cross-event in-memory
 * coordination (semaphores, refs, deferreds) is unsafe; the platform's gate
 * is not.
 */
const exclusively = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    const exit = yield* state.blockConcurrencyWhile(() => Effect.exit(effect));
    return yield* exit;
  });

/** How long a queue drain may hold its lease before another drain may take over. */
const LEASE_MS = 60_000;

/**
 * A durable, ordered work queue in the instance's storage. Rows are written
 * in the same transaction as the state change that produced them, processed
 * right after the commit (`kick`), and again by a durable callback if the
 * instance dies first. One drain runs at a time (a storage lease), rows are
 * processed in order, and a row is deleted only after its work succeeds.
 */
const queue = <Row>(name: string, process: (row: Row) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    const prefix = `${name}:`;
    const lease = `${name}-lease`;
    const acquire = exclusively(
      Effect.gen(function* () {
        const held = yield* state.storage.get<number>(lease);
        if (held !== undefined && held > Date.now()) return false;
        yield* state.storage.put(lease, Date.now() + LEASE_MS);
        return true;
      }),
    );
    const drain: Effect.Effect<void> = Effect.gen(function* () {
      if (!(yield* acquire)) return;
      yield* Effect.gen(function* () {
        const rows = yield* state.storage.list<Row>({ prefix });
        for (const [key, row] of rows) {
          yield* process(row);
          yield* state.storage.delete(key);
        }
      }).pipe(Effect.ensuring(state.storage.delete(lease).pipe(Effect.ignore)));
      // Rows staged while this drain ran.
      const more = yield* state.storage.list({ prefix, limit: 1 });
      if (more.size > 0) yield* drain;
    }) as Effect.Effect<void>;
    const callback = yield* makeCallback(`domain:${name}`, () => drain);
    return {
      /** Stage rows; call inside the storage transaction that commits their cause. */
      stage: (rows: ReadonlyArray<Row>) =>
        Effect.gen(function* () {
          if (rows.length === 0) return;
          const last = ((yield* state.storage.get<number>(`${name}-seq`)) ?? 0) + rows.length;
          const entries: Record<string, Row> = {};
          rows.forEach((row, index) => {
            entries[`${prefix}${pad(last - rows.length + index + 1)}`] = row;
          });
          yield* state.storage.put(entries);
          yield* state.storage.put(`${name}-seq`, last);
          // The backstop: delivered even if this instance dies before `kick` runs.
          yield* callback.schedule("drain", { after: "10 seconds", payload: {} });
        }),
      /** Process staged rows now, in the background, keeping the instance alive until done. */
      kick: state.waitUntil(drain.pipe(Effect.ignoreCause)),
    };
  });

// ---------------------------------------------------------------- live reads

/** What a live read's WebSocket carries across hibernation. */
interface Attachment {
  readonly key: string;
  readonly subscription: Subscription;
}

const SUBSCRIPTION_HEADER = "x-domain-subscription";

/** Send a push to its socket; close it when the read ended or could not be judged. */
const deliverPush = <R>(socket: WebSocket, key: string, push: Effect.Effect<Push, never, R>) =>
  push.pipe(
    Effect.flatMap((pushed) =>
      Effect.gen(function* () {
        // Each frame carries the cursor a reconnecting client resumes from.
        const cursor = pushed.subscription.cursor;
        for (const message of pushed.messages) {
          yield* socket.send(JSON.stringify({ ...(message as object), cursor }));
        }
        if (pushed.done) return yield* socket.close(1000, "");
        yield* Effect.sync(() =>
          socket.serializeAttachment({
            key,
            subscription: pushed.subscription,
          } satisfies Attachment),
        );
      }),
    ),
    Effect.catchCause(() => socket.close(1011, "Domain could not push to this read")),
  );

/**
 * Accept a live read's WebSocket (the current request, forwarded by
 * {@link connectTo}) with the hibernation API, and send what it starts with.
 * Runs exclusively, so no commit's push interleaves with the first one.
 */
const accept = (
  initial: (
    key: string,
    subscription: Subscription,
  ) => Effect.Effect<Push, never, DurableObjectState | RuntimeContext>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const header = request.headers[SUBSCRIPTION_HEADER];
    if (header === undefined || request.headers.upgrade?.toLowerCase() !== "websocket") {
      return HttpServerResponse.empty({ status: 426, headers: { Upgrade: "websocket" } });
    }
    const { key, subscription } = JSON.parse(header) as Attachment;
    return yield* exclusively(
      Effect.gen(function* () {
        const [response, socket] = yield* upgrade();
        if (subscription.refused !== undefined) {
          yield* socket.send(
            JSON.stringify({
              _tag: "Exit",
              requestId: subscription.requestId,
              exit: subscription.refused,
            }),
          );
          yield* socket.close(1000, "");
          return response;
        }
        yield* deliverPush(socket, key, initial(key, subscription));
        return response;
      }),
    );
  });

/** Push to every live read of this instance after a commit. Runs inside the commit's exclusive section. */
const broadcast = (
  push: (attachment: Attachment) => Effect.Effect<Push, never, DurableObjectState | RuntimeContext>,
) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    for (const socket of yield* state.getWebSockets()) {
      const attachment = socket.deserializeAttachment<Attachment>();
      if (attachment === null) continue;
      yield* deliverPush(socket, attachment.key, push(attachment));
    }
  });

/** Live reads only receive; a client message or close needs no work beyond ending the socket. */
const socketHandlers = {
  webSocketMessage: () => Effect.void,
  webSocketClose: (socket: WebSocket) => socket.close(1000, "").pipe(Effect.ignoreCause),
  webSocketError: (socket: WebSocket) => socket.close(1011, "").pipe(Effect.ignoreCause),
};

/**
 * Forward a WebSocket upgrade (the current request) to the instance that owns
 * `key`, carrying the subscription. The Worker sets the header, overwriting
 * any a client sent, so the object can trust it.
 */
const connectTo = (namespace: Namespace) => (key: string, subscription: Subscription) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const forwarded = request.modify({
      headers: Headers.set(
        request.headers,
        SUBSCRIPTION_HEADER,
        JSON.stringify({ key, subscription } satisfies Attachment),
      ),
    });
    // Like every other call, ride out a deploy's rollout: an instance still
    // running the previous script cannot upgrade, so retry until one does.
    const response = yield* namespace
      .getByName(key)
      .fetch(forwarded)
      .pipe(
        Effect.filterOrFail(
          (response) => response.status === 101,
          (response) => new Error(`Live read upgrade answered ${response.status}`),
        ),
        Effect.retry(TRANSIT_RETRY),
        Effect.orDie,
      );
    // A fetched Response's headers are immutable; re-wrap the socket so
    // middleware (CORS, cookies) can still add headers to the upgrade.
    const body = response.body;
    if (body._tag === "Raw" && body.body instanceof Response) {
      const webSocket = (body.body as unknown as { readonly webSocket: unknown }).webSocket;
      if (webSocket) {
        return HttpServerResponse.raw(
          new Response(null, { status: 101, webSocket } as ResponseInit),
          { status: 101 },
        );
      }
    }
    return response;
  });

const aggregateObject = (kit: AggregateKit) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    return Effect.gen(function* () {
      const outbox = yield* queue<Delivery>("outbox", kit.deliver);
      const currentMeta = state.storage
        .get<{ state: Json | null; version: number }>("meta")
        .pipe(Effect.map((meta) => meta ?? { state: null, version: 0 }));
      const eventsAfter = (after: number) =>
        state.storage
          .list<StoredEvent>({ prefix: "event:", start: `event:${pad(after + 1)}` })
          .pipe(Effect.map((rows) => [...rows.values()]));
      const send = (id: string, command: Json, meta: Aggregate.SendMeta) =>
        Effect.gen(function* () {
          const { sent, kick } = yield* exclusively(
            Effect.gen(function* () {
              const duplicate = yield* state.storage.get<SendResult>(`receipt:${meta.commandId}`);
              if (duplicate) return { sent: duplicate, kick: false };
              const current = (yield* state.storage.get<{
                state: Json | null;
                version: number;
              }>("meta")) ?? {
                state: null,
                version: 0,
              };
              const result = yield* kit.handle({
                id,
                state: current.state,
                version: current.version,
                command,
                commandId: meta.commandId,
                context: meta.context,
                now: yield* Effect.sync(() => Date.now()),
                correlationId: meta.correlationId,
                trace: meta.trace,
                link: meta.link,
              });
              if (result._tag === "Rejected") return { sent: result as SendResult, kick: false };
              const sent: SendResult = {
                _tag: "Accepted",
                receipt: {
                  stream: `${kit.name}/${id}`,
                  version: result.version,
                  events: result.events.map((e) => e.event),
                  reply: result.reply,
                },
              };
              yield* state.storage.transaction(
                Effect.gen(function* () {
                  const events: Record<string, StoredEvent> = {};
                  for (const event of result.events)
                    events[`event:${pad(event.envelope.seq)}`] = event;
                  yield* state.storage.put(events);
                  yield* state.storage.put("meta", {
                    state: result.state,
                    version: result.version,
                  });
                  yield* state.storage.put(`receipt:${meta.commandId}`, sent);
                  yield* outbox.stage(result.deliveries);
                }),
              );
              const committed = { state: result.state, version: result.version };
              yield* broadcast(({ key, subscription }) =>
                Effect.gen(function* () {
                  // A subscriber behind this commit's first event reads the gap from storage.
                  const first = result.events[0]?.envelope.seq ?? Infinity;
                  const events =
                    subscription.mode === "events" && subscription.cursor < first - 1
                      ? yield* eventsAfter(subscription.cursor)
                      : result.events;
                  return yield* kit.push(key, subscription, committed, events);
                }),
              );
              return { sent, kick: result.deliveries.length > 0 };
            }),
          );
          if (kick) yield* outbox.kick;
          return sent;
        });
      // Scheduled commands: one durable callback job per command id, run here when due.
      const timers = yield* makeCallback(
        "domain:schedule",
        (job: { readonly id: string; readonly command: Json; readonly meta: Aggregate.SendMeta }) =>
          send(job.id, job.command, job.meta),
      );
      return {
        send: (id: string, command: Json, meta: Aggregate.SendMeta) =>
          reportDefects(send(id, command, meta)),
        schedule: (id: string, command: Json, meta: Aggregate.SendMeta, due: Aggregate.Due) =>
          reportDefects(
            timers.schedule(
              meta.commandId,
              "at" in due
                ? { at: due.at, payload: { id, command, meta } }
                : { after: due.afterMillis, payload: { id, command, meta } },
            ),
          ),
        state: () => reportDefects(currentMeta),
        after: (after: number) => reportDefects(eventsAfter(after)),
        // A live read of this instance: accept its WebSocket, then push on every commit.
        fetch: accept((id, subscription) =>
          Effect.gen(function* () {
            const current = yield* currentMeta;
            const events =
              subscription.mode === "events" ? yield* eventsAfter(subscription.cursor) : [];
            return yield* kit.push(id, subscription, current, events);
          }),
        ),
        ...socketHandlers,
      };
    });
  });

const viewObject = (kit: ViewKit) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    return Effect.gen(function* () {
      const outbox = yield* queue<Delivery>("outbox", kit.deliver);
      const read = state.storage
        .get<ViewSnapshot>("snapshot")
        .pipe(Effect.map((s) => s ?? emptySnapshot));
      const entriesAfter = (after: number) =>
        state.storage
          .list<ViewEntry>({ prefix: "entry:", start: `entry:${pad(after + 1)}` })
          .pipe(Effect.map((rows) => [...rows.values()]));
      return {
        receive: (key: string, deliveries: ReadonlyArray<Delivery>) =>
          reportDefects(
            Effect.gen(function* () {
              const kick = yield* exclusively(
                Effect.gen(function* () {
                  const before = yield* read;
                  const result = kit.apply(key, before, deliveries);
                  if (!result.changed) return false;
                  const rows: Record<string, ViewEntry> = {};
                  for (const entry of result.entries) rows[`entry:${pad(entry.seq)}`] = entry;
                  // The key's immutable input log: every delivery it applied, in order.
                  const accepted = deliveries.filter(
                    (d) => (before.checkpoints[d.source] ?? 0) < d.seq,
                  );
                  yield* state.storage.transaction(
                    Effect.gen(function* () {
                      const inputs = (yield* state.storage.get<number>("in-seq")) ?? 0;
                      const log: Record<string, Delivery> = {};
                      accepted.forEach((delivery, index) => {
                        log[`in:${pad(inputs + index + 1)}`] = delivery;
                      });
                      yield* state.storage.put(log);
                      yield* state.storage.put("in-seq", inputs + accepted.length);
                      yield* state.storage.put("snapshot", result.snapshot);
                      if (result.entries.length > 0) yield* state.storage.put(rows);
                      yield* outbox.stage(result.downstream);
                    }),
                  );
                  yield* broadcast(({ key, subscription }) =>
                    Effect.gen(function* () {
                      // A subscriber behind this commit's first entry reads the gap from storage.
                      const first = result.entries[0]?.seq ?? Infinity;
                      const entries =
                        subscription.mode === "events" && subscription.cursor < first - 1
                          ? yield* entriesAfter(subscription.cursor)
                          : result.entries;
                      return yield* kit.push(key, subscription, result.snapshot, entries);
                    }),
                  );
                  return result.downstream.length > 0;
                }).pipe(kit.observe(key, deliveries)),
              );
              if (kick) yield* outbox.kick;
            }),
          ),
        read: () => reportDefects(read),
        after: (after: number) => reportDefects(entriesAfter(after)),
        // A live read of this key: accept its WebSocket, then push on every commit.
        fetch: accept((key, subscription) =>
          Effect.gen(function* () {
            const snapshot = yield* read;
            const entries =
              subscription.mode === "events" ? yield* entriesAfter(subscription.cursor) : [];
            return yield* kit.push(key, subscription, snapshot, entries);
          }),
        ),
        ...socketHandlers,
      };
    });
  });

const policyObject = (kit: PolicyKit) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    return Effect.gen(function* () {
      const inbox = yield* queue<Delivery>("inbox", kit.run);
      return {
        receive: (delivery: Delivery) =>
          reportDefects(
            Effect.gen(function* () {
              const id = `${delivery.source}:${delivery.seq}`;
              const accepted = yield* exclusively(
                state.storage.transaction(
                  Effect.gen(function* () {
                    if (yield* state.storage.get(`seen:${id}`)) return false;
                    yield* state.storage.put(`seen:${id}`, true);
                    yield* inbox.stage([delivery]);
                    return true;
                  }),
                ),
              );
              if (accepted) yield* inbox.kick;
            }),
          ),
      };
    });
  });

/** The stored progress of one projection key. */
interface ProjectionMeta {
  readonly key: string | null;
  /** Inputs accepted into the log. */
  readonly accepted: number;
  /** Inputs handled. */
  readonly processed: number;
  /** The last accepted `seq` per source: duplicates are dropped on arrival. */
  readonly intake: Readonly<Record<string, number>>;
  /** The last handled `seq` per source. */
  readonly checkpoints: Readonly<Record<string, number>>;
}

const emptyProjectionMeta: ProjectionMeta = {
  key: null,
  accepted: 0,
  processed: 0,
  intake: {},
  checkpoints: {},
};

/** How long a failed or interrupted run waits before it is retried. */
const PROJECTION_RETRY_MS = 10_000;

const projectionObject = (kit: ProjectionKit) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    return Effect.gen(function* () {
      const readMeta = state.storage
        .get<ProjectionMeta>("meta")
        .pipe(Effect.map((meta) => meta ?? emptyProjectionMeta));
      const size = kit.options.batch?.size ?? 1;
      const waitMillis = kit.options.batch?.waitMillis ?? 0;
      const lease = "drain-lease";
      const acquire = exclusively(
        Effect.gen(function* () {
          const held = yield* state.storage.get<number>(lease);
          if (held !== undefined && held > Date.now()) return false;
          yield* state.storage.put(lease, Date.now() + LEASE_MS);
          return true;
        }),
      );
      // Re-run the drain later: when a short batch has waited long enough, or after a failure.
      let wake: (at: number) => Effect.Effect<void> = () => Effect.void;
      const drain: Effect.Effect<void> = Effect.gen(function* () {
        if (!(yield* acquire)) return;
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            while (true) {
              const meta = yield* readMeta;
              if (meta.key === null || meta.processed >= meta.accepted) return;
              const rows = yield* state.storage.list<Accepted>({
                prefix: "in:",
                start: `in:${pad(meta.processed + 1)}`,
                limit: size,
              });
              const run = [...rows.values()];
              if (run.length === 0) return;
              if (run.length < size && waitMillis > 0 && Date.now() - run[0]!.at < waitMillis) {
                return yield* wake(run[0]!.at + waitMillis);
              }
              yield* kit.run(meta.key, run);
              yield* exclusively(
                Effect.gen(function* () {
                  const current = yield* readMeta;
                  const handled: Record<string, number> = {};
                  for (const { delivery } of run) {
                    handled[delivery.source] = Math.max(
                      handled[delivery.source] ?? 0,
                      delivery.seq,
                    );
                  }
                  yield* state.storage.put("meta", {
                    ...current,
                    processed: run[run.length - 1]!.position,
                    checkpoints: mergeCheckpoints(current.checkpoints, handled),
                  } satisfies ProjectionMeta);
                }),
              );
            }
          }),
        );
        yield* state.storage.delete(lease).pipe(Effect.ignore);
        if (exit._tag === "Failure") {
          yield* Effect.logError(`projection ${kit.name} failed; retrying`, exit.cause);
          yield* wake(Date.now() + PROJECTION_RETRY_MS);
        }
      }) as Effect.Effect<void>;
      const callback = yield* makeCallback("domain:projection", () => drain);
      wake = (at) =>
        callback.schedule("drain", { at, payload: {} }).pipe(Effect.ignore) as Effect.Effect<void>;
      return {
        receive: (key: string, delivery: Delivery) =>
          reportDefects(
            Effect.gen(function* () {
              const accepted = yield* exclusively(
                state.storage.transaction(
                  Effect.gen(function* () {
                    const meta = yield* readMeta;
                    if ((meta.intake[delivery.source] ?? 0) >= delivery.seq) return false;
                    const position = meta.accepted + 1;
                    yield* state.storage.put(`in:${pad(position)}`, {
                      position,
                      delivery,
                      at: Date.now(),
                    } satisfies Accepted);
                    yield* state.storage.put("meta", {
                      ...meta,
                      key,
                      accepted: position,
                      intake: { ...meta.intake, [delivery.source]: delivery.seq },
                    } satisfies ProjectionMeta);
                    // The backstop: handled even if this instance dies before the drain runs.
                    yield* callback.schedule("drain", {
                      after: `${Math.max(waitMillis, PROJECTION_RETRY_MS)} millis`,
                      payload: {},
                    });
                    return true;
                  }),
                ),
              );
              if (accepted) yield* state.waitUntil(drain.pipe(Effect.ignoreCause));
            }),
          ),
        checkpoints: () => reportDefects(readMeta.pipe(Effect.map((meta) => meta.checkpoints))),
      };
    });
  });

const streamObject = (kit: StreamKit) =>
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    return Effect.gen(function* () {
      const readMeta = state.storage
        .get<StreamMeta>("meta")
        .pipe(Effect.map((meta) => meta ?? emptyStreamMeta));
      const entriesAfter = (after: number) =>
        state.storage
          .list<StreamEntry>({ prefix: "entry:", start: `entry:${pad(after + 1)}` })
          .pipe(Effect.map((rows) => [...rows.values()]));
      const latest = (meta: StreamMeta) =>
        meta.seq === 0
          ? Effect.succeed(undefined)
          : state.storage.get<StreamEntry>(`entry:${pad(meta.seq)}`);
      return {
        append: (key: string, write: StreamWrite) =>
          reportDefects(
            exclusively(
              Effect.gen(function* () {
                const meta = yield* readMeta;
                if (!isAfter(write.origin, meta.origin)) return;
                const added: Array<StreamEntry> = write.events.map((event, index) => {
                  const seq = meta.seq + index + 1;
                  return {
                    seq,
                    event,
                    envelope: {
                      id: key,
                      stream: `${kit.name}/${key}`,
                      seq,
                      at: write.at,
                      commandId: write.commandId,
                    },
                  };
                });
                const next: StreamMeta = {
                  seq: meta.seq + added.length,
                  origin: write.origin,
                  checkpoints: mergeCheckpoints(meta.checkpoints, {
                    [write.source]: write.sourceSeq,
                  }),
                };
                yield* state.storage.transaction(
                  Effect.gen(function* () {
                    const rows: Record<string, StreamEntry> = {};
                    for (const entry of added) rows[`entry:${pad(entry.seq)}`] = entry;
                    if (added.length > 0) yield* state.storage.put(rows);
                    yield* state.storage.put("meta", next);
                  }),
                );
                if (added.length === 0) return;
                yield* broadcast(({ key, subscription }) =>
                  Effect.gen(function* () {
                    // A subscriber behind this append's first entry reads the gap from storage.
                    const entries =
                      subscription.mode === "events" && subscription.cursor < added[0]!.seq - 1
                        ? yield* entriesAfter(subscription.cursor)
                        : added;
                    return yield* kit.push(
                      key,
                      subscription,
                      next,
                      entries,
                      added[added.length - 1],
                    );
                  }),
                );
              }),
            ),
          ),
        advance: (checkpoints: Readonly<Record<string, number>>) =>
          reportDefects(
            exclusively(
              Effect.gen(function* () {
                const meta = yield* readMeta;
                yield* state.storage.put("meta", {
                  ...meta,
                  checkpoints: mergeCheckpoints(meta.checkpoints, checkpoints),
                } satisfies StreamMeta);
              }),
            ),
          ),
        read: () => reportDefects(readMeta),
        after: (after: number) => reportDefects(entriesAfter(after)),
        // A live read of this key: accept its WebSocket, then push on every append.
        fetch: accept((key, subscription) =>
          Effect.gen(function* () {
            const meta = yield* readMeta;
            const entries =
              subscription.mode === "events" ? yield* entriesAfter(subscription.cursor) : [];
            return yield* kit.push(key, subscription, meta, entries, yield* latest(meta));
          }),
        ),
        ...socketHandlers,
      };
    });
  });

/** How often a subscription re-reads the Durable Object that owns a key. */
const POLL = Schedule.spaced("300 millis");

/** Entries after a cursor, then new ones, by polling the object that owns them. */
const pollAfter = <A>(
  from: number,
  read: (cursor: number) => Effect.Effect<ReadonlyArray<A>>,
  seqOf: (entry: A) => number,
): Stream.Stream<A> =>
  Stream.suspend(() => {
    let first = true;
    return Stream.paginate(from, (cursor: number) => {
      const poll = read(cursor);
      const next = first ? poll : Effect.delay(poll, "300 millis");
      first = false;
      return Effect.map(
        next,
        (fresh) =>
          [
            fresh,
            Option.some(fresh.length > 0 ? seqOf(fresh[fresh.length - 1]!) : cursor),
          ] as const,
      );
    });
  });

/** The aggregates, views, policies, projections and streams, each on its own Durable Object class. */
const DurableObjectPlatform: Layer.Layer<Platform, never, Worker> = Layer.effect(
  Platform,
  Effect.gen(function* () {
    // Factories run while the Domain's Layer is built, inside the Worker's
    // init phase; declaring a Durable Object needs that context.
    const init = yield* captureContext<Worker>();
    const inInit = <A, E>(effect: Effect.Effect<A, E, Worker>): Effect.Effect<A, E> =>
      Effect.provide(effect, init);

    return Platform.of({
      aggregate: (aggregate, kit) =>
        inInit(
          Effect.gen(function* () {
            const namespace = yield* declare(
              `${aggregate.aggregateName}Aggregate`,
              aggregateObject(kit),
            );
            return {
              send: (id, command, meta) =>
                unwrapDefects(namespace.getByName(id).send(id, command, meta)),
              schedule: (id, command, meta, due) =>
                unwrapDefects(namespace.getByName(id).schedule(id, command, meta, due)),
              state: (id) => unwrapDefects(namespace.getByName(id).state()),
              // Streamed responses poll; WebSocket reads (`connect`) are pushed on commit.
              changes: (id) =>
                Stream.fromEffectSchedule(
                  unwrapDefects<{ state: Json | null; version: number }>(
                    namespace.getByName(id).state(),
                  ),
                  POLL,
                ).pipe(Stream.changesWith((a, b) => a.version === b.version)),
              tail: (id, from) =>
                pollAfter(
                  from,
                  (cursor) =>
                    unwrapDefects<ReadonlyArray<StoredEvent>>(
                      namespace.getByName(id).after(cursor),
                    ),
                  (event) => event.envelope.seq,
                ),
              connect: connectTo(namespace),
            };
          }),
        ),
      view: (view, kit) =>
        inInit(
          Effect.gen(function* () {
            const namespace = yield* declare(`${view.viewName}View`, viewObject(kit));
            const read = (key: string) =>
              unwrapDefects<ViewSnapshot>(namespace.getByName(key).read());
            const after = (key: string, cursor: number) =>
              unwrapDefects<ReadonlyArray<ViewEntry>>(namespace.getByName(key).after(cursor));
            return {
              receive: (key, deliveries) =>
                unwrapDefects(namespace.getByName(key).receive(key, deliveries)),
              read,
              // Streamed responses poll; WebSocket reads (`connect`) are pushed on commit.
              changes: (key) =>
                Stream.fromEffectSchedule(read(key), POLL).pipe(
                  Stream.changesWith((a, b) => a.version === b.version),
                ),
              list: (key) => after(key, 0),
              connect: connectTo(namespace),
              tail: (key, from) =>
                Stream.suspend(() => {
                  let first = true;
                  return Stream.paginate(from, (cursor: number) => {
                    const poll = after(key, cursor);
                    const next = first ? poll : Effect.delay(poll, "300 millis");
                    first = false;
                    return Effect.map(
                      next,
                      (fresh) =>
                        [
                          fresh,
                          Option.some(fresh.length > 0 ? fresh[fresh.length - 1]!.seq : cursor),
                        ] as const,
                    );
                  });
                }),
            };
          }),
        ),
      projection: (projection, kit) =>
        inInit(
          Effect.gen(function* () {
            const namespace = yield* declare(
              `${projection.projectionName}Projection`,
              projectionObject(kit),
            );
            return {
              receive: (delivery) =>
                unwrapDefects(namespace.getByName(delivery.key).receive(delivery.key, delivery)),
              checkpoints: (key) =>
                unwrapDefects<Readonly<Record<string, number>>>(
                  namespace.getByName(key).checkpoints(),
                ),
            };
          }),
        ),
      stream: (stream, kit) =>
        inInit(
          Effect.gen(function* () {
            const namespace = yield* declare(`${stream.streamName}Stream`, streamObject(kit));
            const read = (key: string) =>
              unwrapDefects<StreamMeta>(namespace.getByName(key).read());
            const after = (key: string, cursor: number) =>
              unwrapDefects<ReadonlyArray<StreamEntry>>(namespace.getByName(key).after(cursor));
            return {
              append: (key, write) => unwrapDefects(namespace.getByName(key).append(key, write)),
              advance: (key, checkpoints) =>
                unwrapDefects(namespace.getByName(key).advance(checkpoints)),
              read,
              // Streamed responses poll; WebSocket reads (`connect`) are pushed on append.
              changes: (key) =>
                Stream.fromEffectSchedule(read(key), POLL).pipe(
                  Stream.changesWith((a, b) => a.seq === b.seq),
                ),
              list: (key) => after(key, 0),
              tail: (key, from) =>
                pollAfter(
                  from,
                  (cursor) => after(key, cursor),
                  (e) => e.seq,
                ),
              connect: connectTo(namespace),
            };
          }),
        ),
      policy: (policy, kit) =>
        inInit(
          Effect.gen(function* () {
            const namespace = yield* declare(`${policy.policyName}Policy`, policyObject(kit));
            return {
              receive: (delivery) =>
                unwrapDefects(namespace.getByName(delivery.key).receive(delivery)),
            };
          }),
        ),
    });
  }),
);

/**
 * Host a domain model on Cloudflare Durable Objects. Every aggregate, view
 * and policy becomes a Durable Object class on the host Worker, declared
 * while the model's Layer is built, so there are no bindings to write. One
 * instance per aggregate id, per view key, and per policy and source.
 *
 * Commands to one instance run one at a time, and their events, state and
 * outbox commit together. Deliveries to views and policies are at least once
 * and in order per source, and survive restarts. Live reads over
 * `Domain.protocolWebSocket` are WebSockets to the object that owns the key,
 * pushed on every commit; the object hibernates in between.
 *
 * ### Hosting on Cloudflare
 * **Example:** A Worker serving an Api
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankPolicies } from "./Bank.ts";
 * import { CustomerApi } from "./CustomerApi.ts";
 * import { SessionLive } from "./Session.ts";
 *
 * const BankLive = SessionLive.pipe(
 *   Layer.provideMerge(Bank.layer(BankPolicies)),
 *   Layer.provide(DomainCloudflare.DurableObjects),
 * );
 *
 * export default class BankWorker extends Cloudflare.Worker<BankWorker>()(
 *   "BankWorker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const api = yield* CustomerApi;
 *     return { fetch: api.fetch };
 *   }).pipe(Effect.provide(BankLive)),
 * ) {}
 * ```
 *
 * @layer
 * @provides Domain.Platform
 * @provides WorkflowEngine
 */
export const DurableObjects: Layer.Layer<Platform | WorkflowEngine.WorkflowEngine, never, Worker> =
  Layer.merge(DurableObjectPlatform, DurableObjectEngine);
