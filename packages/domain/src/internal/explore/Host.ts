/**
 * The explore host: a Domain `Platform` (the SPI of `Platform.ts`) whose whole
 * state is plain data (`World`), so a state can be encoded, compared and
 * rebuilt. It follows InMemory's semantics where the SPI leaves a choice, and
 * names every other choice in the host profile.
 *
 * - Aggregates: single writer per id, dedupe by commandId with the FULL
 *   receipt, state + receipt + outbound work in one step (`receive`
 *   only appends data, so it cannot fail half way).
 * - Policies: work partitioned by `(policy, key)`, accepted in `receive`
 *   order (commit order); the head of a partition runs.
 * - Views: executed (queued work or inline), snapshots and entries are state;
 *   a view may be `abstract` only when nothing consumes it.
 * - Projections: `{next, pending, intake, checkpoints}` per key; positions are
 *   partition positions; checkpoints move only after a run succeeds.
 * - Streams, sagas and live reads are refused, never answered empty.
 * - Clock: the world's; `Clock.sleep` is an engine error.
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AlreadyCancelled, AlreadyExecuted, NotScheduled } from "../../Aggregate.ts";
import {
  emptySnapshot,
  Platform,
  type Accepted,
  type AggregateKit,
  type Delivery,
  type Json,
  type PolicyKit,
  type ProjectionKit,
  type SendResult,
  type ViewEntry,
  type ViewKit,
  type ViewSnapshot,
} from "../../Platform.ts";
import { EngineFault, HostFault, type EngineError } from "./Errors.ts";

// ─────────────────────────────────────────────────────────────── World ──

export interface Inst {
  state: Json;
  version: number;
  /** commandId → the full result: a seen id answers its old receipt. */
  receipts: Record<string, SendResult>;
  /** Ids cancelled and not scheduled again since. */
  cancelled: Record<string, true>;
  /** commandId → the inputs that scheduled it (for the derived TIMER-REARM rule). */
  armedBy: Record<string, Array<string>>;
}

export interface WorkItem {
  readonly d: Delivery;
  tries: number;
}

export interface TimerRec {
  readonly agg: string;
  readonly id: string;
  readonly command: Json;
  readonly meta: {
    readonly commandId: string;
    readonly context: Json;
    readonly correlationId?: string;
  };
  readonly at: number;
}

export interface ViewPart {
  snapshot: ViewSnapshot;
  entries: Array<ViewEntry>;
}

export interface ProjPart {
  /** Positions handed out so far (the key's input log length). */
  next: number;
  /** Accepted and not yet processed, in order. The processed prefix is dropped: no SPI call reads it. */
  pending: Array<Accepted>;
  intake: Record<string, number>;
  checkpoints: Record<string, number>;
  tries: number;
  /** Failed more than `maxTries`: the partition stops (a host blocks it); DEAD-LETTER reports it. */
  stuck: boolean;
}

export interface Dead {
  readonly kind: "policy" | "view" | "projection";
  readonly target: string;
  readonly key: string;
  readonly tag: string;
  readonly source: string;
  readonly seq: number;
  readonly error: string;
}

export interface World {
  clock: number;
  aggs: Record<string, Record<string, Inst>>;
  /** Policy and view work by partition `kind|target|key`, in acceptance order. */
  work: Record<string, Array<WorkItem>>;
  timers: Record<string, TimerRec>;
  views: Record<string, Record<string, ViewPart>>;
  proj: Record<string, Record<string, ProjPart>>;
  /** The state of each fake, by name (plain JSON). */
  ext: Record<string, Json>;
  /** The last delivered item of each partition, while a redelivery may happen. */
  delivered: Record<string, WorkItem>;
  dead: Array<Dead>;
  budget: Record<string, number>;
}

export const partitionKey = (kind: "policy" | "view" | "projection", target: string, key: string) =>
  `${kind}|${target}|${key}`;

export const splitPartition = (pk: string) => {
  const [kind, target, ...rest] = pk.split("|");
  return { kind: kind as "policy" | "view" | "projection", target: target!, key: rest.join("|") };
};

// ─────────────────────────────────────────────────────────── Step log ──

export interface Commit {
  readonly agg: string;
  readonly id: string;
  readonly commandTag: string;
  readonly commandId: string;
  readonly events: ReadonlyArray<{ readonly _tag: string } & Record<string, unknown>>;
  readonly before: Json;
  readonly after: Json;
  readonly now: number;
  readonly by: string;
}

export interface Call {
  readonly system: string;
  readonly op: string;
  readonly args: Record<string, unknown>;
  readonly outcome: string;
}

/** A context service an actor's send provides (a Story provides it too). */
export interface Provided {
  readonly key: Context.Key<any, any>;
  readonly value: unknown;
  /** The TS expression of the value, for a Story. */
  readonly code: string;
  /** The TS expression of the service key, for a Story. */
  readonly keyCode: string;
}

export interface Send {
  readonly agg: string;
  readonly id: string;
  readonly command: unknown;
  readonly commandId: string;
  readonly provide: ReadonlyArray<Provided>;
  rejection?: unknown;
  fault?: string;
}

export interface StepLog {
  commits: Array<Commit>;
  rejections: Array<{ agg: string; id: string; commandTag: string; rejection: Json; by: string }>;
  calls: Array<Call>;
  /** Modeled failures (a refused fake call, a host fault, a failed run that will be retried). */
  failures: Array<{ where: string; error: string }>;
  /** Model defects: a die that is not a host fault (an evolve guard, a bug in a handler). */
  defects: Array<{ where: string; error: string }>;
  faults: Array<{ where: string; point: "before-commit" | "after-commit" }>;
  sends: Array<Send>;
  enqueued: Array<{ pk: string; source: string; seq: number; tag: string }>;
  /**
   * schedule() answered AlreadyExecuted. `repeat`: the same input armed it before.
   * `sameStream`: the input and the command share a stream, so their order is known.
   * `served`: the command ran after the input committed. `stale`: it ran and recorded no event.
   */
  refusedSchedules: Array<{
    agg: string;
    id: string;
    commandId: string;
    input: string;
    repeat: boolean;
    sameStream: boolean;
    served: boolean;
    stale: boolean;
  }>;
  /** The move's main effect succeeded. */
  ok: boolean;
}

export const emptyLog = (): StepLog => ({
  commits: [],
  rejections: [],
  calls: [],
  failures: [],
  defects: [],
  faults: [],
  sends: [],
  enqueued: [],
  refusedSchedules: [],
  ok: true,
});

// ────────────────────────────────────────────────────── Host profile ──

export interface By {
  readonly kind: "actor" | "policy" | "timer" | "view" | "projection" | "engine";
  readonly name: string;
}

export const byText = (by: By) =>
  by.kind === "actor" || by.kind === "timer" ? by.kind : `${by.kind} ${by.name}`;

export interface HostProfile {
  /** Which sends may meet a host fault (budget `faults`): before commit (lost) or after (reply lost). */
  readonly faultable?: (send: {
    readonly target: string;
    readonly command: string;
    readonly by: By;
  }) => boolean;
  /** `_tag`s of deliberate dies that mean "fail this delivery, retry it" (a policy handler has no error channel). Every other die is a DEFECT. */
  readonly retryDefects?: ReadonlyArray<string>;
  /** A failed run is retried; after `maxTries` failures it is a dead letter. Default 2. */
  readonly maxTries?: number;
  /** Per view: `queued` (default, exact), `inline` (applied in the step that committed: no lag), `abstract` (not run; only when nothing consumes it). */
  readonly views?: Readonly<Record<string, "queued" | "inline" | "abstract">>;
  /** Per projection: `queued` (default; a run takes any batch size up to the option) or `inline` (all pending as one batch in the step that committed). */
  readonly projections?: Readonly<Record<string, "queued" | "inline">>;
}

// ──────────────────────────────────────────────────── Runtime holder ──

export interface ScriptEntry {
  readonly label: string;
  readonly n: number;
  readonly chosen: number;
}

/** The mutable cell of one exploration: the host, the fakes and the moves read it. */
export class Rt {
  readonly profile: HostProfile;
  world!: World;
  log: StepLog = emptyLog();
  by: By = { kind: "engine", name: "" };
  /** The input being handled (`policy|source#seq`, `actor:key`, `timer:key`): TIMER-REARM's repeat test. */
  input = "";
  /** The source stream and seq of the delivery being handled (policy runs). */
  inputSource: string | undefined;
  inputSeq = 0;
  script: ReadonlyArray<ScriptEntry> = [];
  pos = 0;
  taken: Array<ScriptEntry> = [];
  /** Swarm: pick unscripted choices at random instead of the default 0. */
  random: (() => number) | undefined;
  /** Run-out of `eventually`: no host fault, default choices only. */
  calm = false;
  engine: Array<EngineError> = [];
  readonly aggregates = new Map<
    string,
    {
      kit: AggregateKit;
      commit: (id: string, command: Json, meta: any) => Effect.Effect<SendResult>;
    }
  >();
  readonly policies = new Map<string, PolicyKit>();
  readonly views = new Map<string, ViewKit>();
  readonly projections = new Map<string, ProjectionKit>();
  readonly setup: Array<string> = [];
  armedByOn = true;

  constructor(profile: HostProfile) {
    this.profile = profile;
  }
}

let active: Rt | undefined;

export const withActive = <A>(rt: Rt, f: () => A): A => {
  const prev = active;
  active = rt;
  try {
    return f();
  } finally {
    active = prev;
  }
};

export const runningRt = (): Rt => current("send");

const current = (what: string): Rt => {
  if (!active) throw new EngineFault("OutsideMove", `${what} called outside a move`);
  return active;
};

/**
 * A branch point: the explorer runs every option (index 0 is the default).
 * On replay the label and the option count must match the trace.
 */
export const choose = <A extends string>(label: string, options: ReadonlyArray<A>): A => {
  const rt = current("choose");
  if (options.length <= 1) return options[0]!;
  let chosen = 0;
  if (rt.pos < rt.script.length) {
    const s = rt.script[rt.pos]!;
    if (s.label !== label || s.n !== options.length)
      throw new EngineFault(
        "ReplayDiverged",
        `choice ${rt.pos}: expected ${s.label}/${s.n}, met ${label}/${options.length}`,
      );
    chosen = s.chosen;
  } else if (rt.random && !rt.calm) chosen = Math.floor(rt.random() * options.length);
  rt.pos++;
  rt.taken.push({ label, n: options.length, chosen });
  return options[chosen]!;
};

/** Spend one unit of a budget; false when it is spent. */
export const spend = (name: string): boolean => {
  const rt = current("spend");
  const left = rt.world.budget[name] ?? 0;
  if (left <= 0) return false;
  rt.world.budget[name] = left - 1;
  if (name === "redeliveries" && left - 1 <= 0) rt.world.delivered = {};
  return true;
};

/** What is left of a budget. */
export const budgetLeft = (name: string): number => {
  const rt = current("budgetLeft");
  return rt.world.budget[name] ?? 0;
};

/** The state of a fake (plain JSON, mutable inside the move). */
export const fakeState = <S>(name: string): S => {
  const rt = current("fakeState");
  if (!(name in rt.world.ext))
    throw new EngineFault("Unsupported", `fake '${name}' has no state (declare it in fakes)`);
  return rt.world.ext[name] as S;
};

/** Record a call to an external system, for step rules. */
export const recordCall = (call: Call) => {
  current("recordCall").log.calls.push(call);
};

/** The world clock (for fakes that need the time). */
export const now = () => current("now").world.clock;

/** Who is running (actor / policy / timer), for fakes. */
export const runningAs = (): By => current("runningAs").by;

export const isHostFault = (e: unknown): e is HostFault => e instanceof HostFault;

export const errorText = (cause: Cause.Cause<unknown>): string => {
  const e = Cause.squash(cause) as any;
  if (e instanceof HostFault || e instanceof EngineFault) return e.message;
  if (e && typeof e === "object" && "_tag" in e)
    return `${e._tag}${e.reason ? `(${e.reason})` : ""}${e.message ? `: ${e.message}` : ""}`;
  return String(e?.message ?? e);
};

/** Classify a failed exit: host fault, engine fault, defect, or a typed failure. */
export const classify = (
  cause: Cause.Cause<unknown>,
  profile?: HostProfile,
): "hostFault" | "engine" | "defect" | "failure" => {
  const e = Cause.squash(cause) as any;
  if (e instanceof HostFault) return "hostFault";
  if (e instanceof EngineFault) return "engine";
  if (e?._tag === "AsyncFiberError" || e?.name === "AsyncFiberError") return "engine";
  if (!Cause.hasDies(cause)) return "failure";
  // A deliberate die the host retries (a policy handler has no error channel).
  return profile?.retryDefects?.includes(e?._tag) ? "failure" : "defect";
};

export const engineErrorOf = (cause: Cause.Cause<unknown>): EngineError => {
  const e = Cause.squash(cause) as any;
  if (e instanceof EngineFault) return { kind: e.kind, detail: e.detail };
  return { kind: "AsyncEffect", detail: String(e?.message ?? e) };
};

const clone = <A>(a: A): A => JSON.parse(JSON.stringify(a));

// ──────────────────────────────────────────────────────── The host ──

const ensureInst = (rt: Rt, agg: string, id: string): Inst => {
  const byId = (rt.world.aggs[agg] ??= {});
  return (byId[id] ??= { state: null, version: 0, receipts: {}, cancelled: {}, armedBy: {} });
};

const enqueue = (rt: Rt, kind: "policy" | "view", target: string, d: Delivery) => {
  const pk = partitionKey(kind, target, d.key);
  (rt.world.work[pk] ??= []).push({ d: clone(d), tries: 0 });
  rt.log.enqueued.push({ pk, source: d.source, seq: d.seq, tag: d.tag });
};

const unsupported = (what: string) => Effect.die(new EngineFault("Unsupported", what));
const unsupportedStream = (what: string) => Stream.die(new EngineFault("Unsupported", what));

/** A Domain `Platform` whose state is `rt.world`. */
export const explorePlatform = (rt: Rt) =>
  Platform.of({
    aggregate: (_aggregate, kit) =>
      Effect.sync(() => {
        const name = kit.name;
        const commit = (id: string, command: Json, meta: any): Effect.Effect<SendResult> =>
          Effect.suspend(() => {
            const found = rt.world.aggs[name]?.[id];
            const duplicate = found?.receipts[meta.commandId];
            if (duplicate) return Effect.succeed(clone(duplicate));
            const tag = (command as { _tag?: string } | null)?._tag ?? "?";
            return kit
              .handle({
                id,
                state: found?.state ?? null,
                version: found?.version ?? 0,
                command,
                commandId: meta.commandId,
                context: meta.context,
                now: rt.world.clock,
                correlationId: meta.correlationId,
              })
              .pipe(
                Effect.tapCause((cause) =>
                  Effect.sync(() => {
                    if (classify(cause, rt.profile) === "defect")
                      rt.log.defects.push({
                        where: `${name}/${id} ${tag}`,
                        error: errorText(cause),
                      });
                  }),
                ),
                Effect.flatMap((result) => {
                  if (result._tag === "Rejected") {
                    rt.log.rejections.push({
                      agg: name,
                      id,
                      commandTag: tag,
                      rejection: result.rejection,
                      by: byText(rt.by),
                    });
                    return Effect.succeed(result as SendResult);
                  }
                  const inst = ensureInst(rt, name, id);
                  const before = inst.state;
                  inst.state = result.state;
                  inst.version = result.version;
                  const sent: SendResult = {
                    _tag: "Accepted",
                    receipt: {
                      stream: `${name}/${id}`,
                      version: result.version,
                      events: result.events.map((e) => e.event),
                      reply: result.reply,
                    },
                  };
                  inst.receipts[meta.commandId] = clone(sent);
                  rt.log.commits.push({
                    agg: name,
                    id,
                    commandTag: tag,
                    commandId: meta.commandId,
                    events: result.events.map((e) => e.event as { _tag: string }),
                    before,
                    after: result.state,
                    now: rt.world.clock,
                    by: byText(rt.by),
                  });
                  return Effect.forEach(result.deliveries, (d) => kit.deliver(d), {
                    discard: true,
                  }).pipe(Effect.as(sent));
                }),
              );
          });
        rt.aggregates.set(name, { kit, commit });
        const send = (id: string, command: Json, meta: any) =>
          Effect.suspend(() => {
            const tag = (command as { _tag?: string } | null)?._tag ?? "?";
            const canFault =
              !rt.calm &&
              rt.profile.faultable?.({ target: name, command: tag, by: rt.by }) === true &&
              budgetLeft("faults") > 0;
            const fault = canFault
              ? choose(`fault:${name}.${tag}`, ["ok", "lost", "late"] as const)
              : "ok";
            if (fault === "lost") {
              spend("faults");
              rt.log.faults.push({ where: `${name}.${tag}`, point: "before-commit" });
              return Effect.die(new HostFault(`${name}.${tag} lost before commit`));
            }
            return commit(id, command, meta).pipe(
              Effect.flatMap((result) => {
                if (fault !== "late") return Effect.succeed(result);
                spend("faults");
                rt.log.faults.push({ where: `${name}.${tag}`, point: "after-commit" });
                return Effect.die(new HostFault(`${name}.${tag} reply lost after commit`));
              }),
            );
          });
        return {
          send,
          schedule: (id, command, meta, due) =>
            Effect.suspend(() => {
              const fields = { aggregate: name, id, commandId: meta.commandId };
              const found = rt.world.aggs[name]?.[id];
              if (found?.receipts[meta.commandId]) {
                const receipt = found.receipts[meta.commandId]!;
                const ranAt = receipt._tag === "Accepted" ? receipt.receipt.version : -1;
                rt.log.refusedSchedules.push({
                  sameStream: rt.inputSource === `${name}/${id}`,
                  served: ranAt >= rt.inputSeq,
                  stale: receipt._tag === "Accepted" && receipt.receipt.events.length === 0,
                  agg: name,
                  id,
                  commandId: meta.commandId,
                  input: rt.input,
                  repeat: (found.armedBy[meta.commandId] ?? []).includes(rt.input),
                });
                return Effect.fail(new AlreadyExecuted(fields));
              }
              const inst = ensureInst(rt, name, id);
              delete inst.cancelled[meta.commandId];
              if (rt.armedByOn) {
                const by = (inst.armedBy[meta.commandId] ??= []);
                if (!by.includes(rt.input)) by.push(rt.input);
              }
              const at = "at" in due ? (due.at as number) : rt.world.clock + due.afterMillis;
              rt.world.timers[`${name}/${id}/${meta.commandId}`] = {
                agg: name,
                id,
                command: clone(command),
                meta: {
                  commandId: meta.commandId,
                  context: clone(meta.context ?? {}),
                  ...(meta.correlationId ? { correlationId: meta.correlationId } : {}),
                },
                at,
              };
              return Effect.succeed(at);
            }),
          unschedule: (id, commandId) =>
            Effect.suspend(
              (): Effect.Effect<void, AlreadyExecuted | AlreadyCancelled | NotScheduled> => {
                const key = `${name}/${id}/${commandId}`;
                const fields = { aggregate: name, id, commandId };
                const found = rt.world.aggs[name]?.[id];
                if (found?.receipts[commandId]) return Effect.fail(new AlreadyExecuted(fields));
                if (found?.cancelled[commandId]) return Effect.fail(new AlreadyCancelled(fields));
                if (!rt.world.timers[key]) return Effect.fail(new NotScheduled(fields));
                delete rt.world.timers[key];
                ensureInst(rt, name, id).cancelled[commandId] = true;
                return Effect.void;
              },
            ),
          state: (id) =>
            Effect.sync(() => {
              const found = rt.world.aggs[name]?.[id];
              return { state: found?.state ?? null, version: found?.version ?? 0 };
            }),
          changes: () => unsupportedStream(`${name}.changes (live reads are not explored)`),
          tail: () => unsupportedStream(`${name}.tail (live reads are not explored)`),
        };
      }),
    view: (_view, kit) =>
      Effect.sync(() => {
        const name = kit.name;
        rt.views.set(name, kit);
        const mode = rt.profile.views?.[name] ?? "queued";
        const snap = (key: string): ViewSnapshot =>
          rt.world.views[name]?.[key]?.snapshot ?? emptySnapshot;
        const abstract = (what: string) => unsupported(`view ${name} is abstract: ${what}`);
        return {
          receive: (_key, deliveries) =>
            Effect.sync(() => {
              if (mode === "abstract") return;
              for (const d of deliveries) enqueue(rt, "view", name, d);
            }),
          read: (key) =>
            mode === "abstract"
              ? abstract("read")
              : Effect.sync(() => {
                  return snap(key);
                }),
          changes: () => unsupportedStream(`view ${name}.changes (live reads are not explored)`),
          list: (key) =>
            mode === "abstract"
              ? abstract("list")
              : Effect.sync(() => {
                  return [...(rt.world.views[name]?.[key]?.entries ?? [])];
                }),
          tail: () => unsupportedStream(`view ${name}.tail (live reads are not explored)`),
        };
      }),
    policy: (_policy, kit) =>
      Effect.sync(() => {
        rt.policies.set(kit.name, kit);
        return {
          receive: (delivery) =>
            Effect.sync(() => {
              if (delivery.history) return;
              enqueue(rt, "policy", kit.name, delivery);
            }),
        };
      }),
    projection: (_projection, kit) =>
      Effect.sync(() => {
        const name = kit.name;
        rt.projections.set(name, kit);
        if (kit.options.batch && (rt.profile.projections?.[name] ?? "queued") === "queued")
          rt.setup.push(
            `projection ${name} has a batch option: declare it inline (a host waits for a full batch or a flush; a queued run cannot say when)`,
          );
        return {
          receive: (delivery) =>
            Effect.sync(() => {
              const pk = partitionKey("projection", name, delivery.key);
              const part = ((rt.world.proj[name] ??= {})[delivery.key] ??= {
                next: 0,
                pending: [],
                intake: {},
                checkpoints: {},
                tries: 0,
                stuck: false,
              });
              if ((part.intake[delivery.source] ?? 0) >= delivery.seq) return;
              part.intake[delivery.source] = delivery.seq;
              part.pending.push({
                position: ++part.next,
                delivery: clone(delivery),
                at: rt.world.clock,
              });
              rt.log.enqueued.push({
                pk,
                source: delivery.source,
                seq: delivery.seq,
                tag: delivery.tag,
              });
            }),
          checkpoints: (key) =>
            Effect.sync(() => {
              return { ...rt.world.proj[name]?.[key]?.checkpoints };
            }),
        };
      }),
    stream: (stream) =>
      Effect.sync(() => {
        rt.setup.push(
          `stream ${(stream as { streamName?: string }).streamName ?? "?"} (streams are not explored)`,
        );
        const no = () => unsupported("stream");
        return {
          append: no,
          advance: no,
          read: no,
          changes: () => unsupportedStream("stream"),
          list: no,
          tail: () => unsupportedStream("stream"),
        };
      }),
  });

/** The clock every effect reads: the world's. `sleep` is an engine error. */
export const worldClock = (rt: Rt): Clock.Clock =>
  ({
    currentTimeMillisUnsafe: () => rt.world.clock,
    currentTimeMillis: Effect.sync(() => rt.world.clock),
    currentTimeNanosUnsafe: () => BigInt(rt.world.clock) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(rt.world.clock) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(rt.world.clock) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(rt.world.clock) * 1_000_000n),
    sleep: () =>
      Effect.suspend(() => {
        const fault = new EngineFault(
          "ClockSleep",
          `Clock.sleep in ${byText(rt.by)} (a policy retry schedule or a delay)`,
        );
        rt.engine.push({ kind: fault.kind, detail: fault.detail });
        return Effect.die(fault);
      }),
  }) as never;

/** Run `f` with hidden randomness refused and `Date.now` on the world clock. */
export const sandboxed = <A>(rt: Rt, f: () => A): A => {
  const random = Math.random;
  const uuid = globalThis.crypto?.randomUUID;
  const dateNow = Date.now;
  const refuse = (what: string) => () => {
    const fault = new EngineFault("HiddenRandomness", `${what} in ${byText(rt.by)}`);
    rt.engine.push({ kind: fault.kind, detail: fault.detail });
    throw fault;
  };
  Math.random = refuse("Math.random");
  if (globalThis.crypto) (globalThis.crypto as any).randomUUID = refuse("crypto.randomUUID");
  Date.now = () => rt.world.clock;
  try {
    return f();
  } finally {
    Math.random = random;
    if (globalThis.crypto) (globalThis.crypto as any).randomUUID = uuid;
    Date.now = dateNow;
  }
};
