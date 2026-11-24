import * as Effect from "effect/Effect";
import type { Kit, Model, Models } from "../Kit.ts";
import { arr, dual, lazy, native, wrongArguments } from "../Kit.ts";
import type { Eval, Site, V } from "../Value.ts";
import * as Value from "../Value.ts";

const REF: Value.Brand = { kind: "Ref", cls: undefined };
/** The field that says which of these a value is. */
const IS = "~is";

type Fields = Record<string, V>;

/**
 * `Deferred`, `Queue`, `Semaphore` and `Latch`: what one part of a program
 * waits on for another. A handler is one fiber that runs to its end without
 * waiting, so each is what the handler itself last did to it. A call that
 * would wait (a `Deferred` nothing has completed, a `Queue` with nothing in
 * it) never ends in a handler: it is reported, and never read as something
 * else.
 */
export const make = (kit: Kit) => {
  const { host } = kit;

  const fieldsOf = (kind: string, v: V | undefined): Fields | undefined => {
    const is = v?._tag === "Obj" && v.brand?.kind === "Ref" ? v.fields[IS] : undefined;
    return is?._tag === "Str" && is.value === kind ? (v as { fields: Fields }).fields : undefined;
  };

  const waits = (site: Site, what: string): Eval<never> =>
    Effect.fail(
      Value.notTranslated(
        site,
        `${what}: a handler runs to its end without waiting, so it never would`,
      ),
    );

  const whole = (v: V | undefined): number | undefined =>
    v?._tag === "Num" && Number.isInteger(v.value) && v.value >= 0 ? v.value : undefined;

  const rejected = (rejection: V, defect = false): Eval<never> =>
    Effect.fail(new Value.Rejected(defect ? { rejection, defect } : { rejection }));

  /** A function of one of these that gives an effect: it is read and changed when the effect runs. */
  const on = (
    kind: string,
    name: string,
    arity: number,
    run: (fields: Fields, rest: ReadonlyArray<V>, site: Site) => Eval<V>,
  ): Model =>
    dual(`${kind}.${name}`, arity, ([self, ...rest], site) => {
      const fields = fieldsOf(kind, self);
      return fields
        ? Effect.succeed(lazy(() => run(fields, rest, site)))
        : wrongArguments(site, `${kind}.${name}`);
    });

  /** A function of one of these that gives a value at once. */
  const now = (
    kind: string,
    name: string,
    arity: number,
    run: (fields: Fields, rest: ReadonlyArray<V>, site: Site) => Eval<V>,
  ): Model =>
    dual(`${kind}.${name}`, arity, ([self, ...rest], site) => {
      const fields = fieldsOf(kind, self);
      return fields ? run(fields, rest, site) : wrongArguments(site, `${kind}.${name}`);
    });

  const made =
    (build: (args: ReadonlyArray<V>, site: Site) => Eval<V>): Model =>
    (args, site) =>
      Effect.succeed(lazy(() => build(args, site)));

  // --- Deferred: completed once, by the handler itself.

  const deferred = (): V => Value.obj({ [IS]: Value.str("Deferred") }, REF);

  /** Completes a `Deferred` with an effect, where nothing has: whether it did. */
  const completes = (name: string, done: (rest: ReadonlyArray<V>, site: Site) => Eval<V>) =>
    on("Deferred", name, 2, (fields, rest, site) => {
      if (fields.done) return Effect.succeed(Value.bool(false));
      return Effect.map(done(rest, site), (outcome) => {
        fields.done = outcome;
        return Value.bool(true);
      });
    });

  const thunk = (name: string, rest: ReadonlyArray<V>, site: Site): Eval<V> =>
    rest[0] ? host.call(rest[0], [], site) : wrongArguments(site, `Deferred.${name}`);

  const deferreds: Models = {
    "effect/Deferred:make": made(() => Effect.sync(deferred)),
    "effect/Deferred:makeUnsafe": () => Effect.sync(deferred),
    "effect/Deferred:succeed": completes("succeed", ([value]) =>
      Effect.succeed(lazy(() => Effect.succeed(value ?? Value.undef))),
    ),
    "effect/Deferred:sync": completes("sync", (rest, site) =>
      Effect.map(thunk("sync", rest, site), (value) => lazy(() => Effect.succeed(value))),
    ),
    "effect/Deferred:fail": completes("fail", ([error]) =>
      Effect.succeed(lazy(() => rejected(error ?? Value.undef))),
    ),
    "effect/Deferred:failSync": completes("failSync", (rest, site) =>
      Effect.map(thunk("failSync", rest, site), (error) => lazy(() => rejected(error))),
    ),
    "effect/Deferred:die": completes("die", ([defect]) =>
      Effect.succeed(lazy(() => rejected(defect ?? Value.undef, true))),
    ),
    "effect/Deferred:dieSync": completes("dieSync", (rest, site) =>
      Effect.map(thunk("dieSync", rest, site), (defect) => lazy(() => rejected(defect, true))),
    ),
    "effect/Deferred:await": on("Deferred", "await", 1, (fields, _, site) =>
      fields.done?._tag === "Effect"
        ? fields.done.run
        : waits(site, "waits for a Deferred the handler has not completed"),
    ),
    "effect/Deferred:isDone": on("Deferred", "isDone", 1, (fields) =>
      Effect.succeed(Value.bool(fields.done !== undefined)),
    ),
    "effect/Deferred:isDoneUnsafe": now("Deferred", "isDoneUnsafe", 1, (fields) =>
      Effect.succeed(Value.bool(fields.done !== undefined)),
    ),
    "effect/Deferred:poll": on("Deferred", "poll", 1, (fields) =>
      Effect.succeed(fields.done ? Value.some(fields.done) : Value.none),
    ),
  };

  // --- Latch: open or closed, as the handler left it.

  const isOpen = (fields: Fields): boolean => fields.open?._tag === "Bool" && fields.open.value;

  const latchWaits = (site: Site) => waits(site, "waits for a Latch the handler has not opened");

  const latch = (open: boolean, site: Site): V => {
    const fields: Fields = { [IS]: Value.str("Latch"), open: Value.bool(open) };
    const opens = (): V => {
      const changed = !isOpen(fields);
      fields.open = Value.bool(true);
      return Value.bool(changed);
    };
    const closes = (): V => {
      const changed = isOpen(fields);
      fields.open = Value.bool(false);
      return Value.bool(changed);
    };
    const self = Value.obj(fields, REF);
    // The latch's own members: `latch.open`, `latch.await`, `latch.whenOpen(effect)`.
    Object.assign(fields, {
      "~open": lazy(() => Effect.sync(opens)),
      "~close": lazy(() => Effect.sync(closes)),
      "~openUnsafe": native("latch.openUnsafe", () => Effect.sync(opens)),
      "~closeUnsafe": native("latch.closeUnsafe", () => Effect.sync(closes)),
      // Nothing waits on a latch in a handler: `release` lets no one through.
      "~release": lazy(() => Effect.sync(() => Value.bool(!isOpen(fields)))),
      "~await": lazy(() => (isOpen(fields) ? Effect.succeed(Value.undef) : latchWaits(site))),
      "~whenOpen": native("latch.whenOpen", ([effect], site) =>
        effect?._tag === "Effect"
          ? Effect.succeed(lazy(() => (isOpen(fields) ? effect.run : latchWaits(site))))
          : wrongArguments(site, "latch.whenOpen"),
      ),
      "~isOpen": native("latch.isOpen", () => Effect.sync(() => Value.bool(isOpen(fields)))),
    });
    return self;
  };

  /** Whether a latch is made open: a path for each, where an input decides. */
  const flag = (v: V | undefined, site: Site): Eval<boolean> =>
    v === undefined || v._tag === "Undef" ? Effect.succeed(false) : host.decide(v, site);

  /** A function of the module that is the latch's own member. */
  const ofLatch =
    (name: string, calls: boolean, arity = 1): Model =>
    ([self, ...rest], site) => {
      const fields = fieldsOf("Latch", self);
      const member = fields?.[`~${name}`];
      if (!member || (arity === 1 && rest.length > 0)) return wrongArguments(site, `Latch.${name}`);
      if (!calls) return Effect.succeed(member);
      // `Latch.whenOpen(latch)` is the latch's `whenOpen`, to be given the effect.
      if (name === "whenOpen" && rest.length === 0) return Effect.succeed(member);
      return host.call(member, rest, site);
    };

  const latches: Models = {
    "effect/Latch:make": made(([open], site) =>
      Effect.map(flag(open, site), (opened) => latch(opened, site)),
    ),
    "effect/Latch:makeUnsafe": ([open], site) =>
      Effect.map(flag(open, site), (opened) => latch(opened, site)),
    "effect/Latch:open": ofLatch("open", false),
    "effect/Latch:close": ofLatch("close", false),
    "effect/Latch:release": ofLatch("release", false),
    "effect/Latch:await": ofLatch("await", false),
    "effect/Latch:openUnsafe": ofLatch("openUnsafe", true),
    "effect/Latch:closeUnsafe": ofLatch("closeUnsafe", true),
    "effect/Latch:isOpen": ofLatch("isOpen", true),
    "effect/Latch:whenOpen": ofLatch("whenOpen", true, 2),
  };

  // --- Semaphore: so many permits, of which the handler holds some.

  const count = (name: string, v: V | undefined, site: Site): Eval<number> => {
    const n = whole(v);
    return n === undefined
      ? Effect.fail(
          Value.notTranslated(site, `calls ${name} with a count of permits the prover cannot see`),
        )
      : Effect.succeed(n);
  };

  const semaphore = (permits: number): V => {
    const state = { permits, taken: 0 };
    const free = () => state.permits - state.taken;
    const semaphoreWaits = (site: Site) =>
      waits(site, "waits for more permits of a Semaphore than are free");
    const counted =
      (name: string, run: (n: number, site: Site) => Eval<V>) =>
      (args: ReadonlyArray<V>, site: Site): Eval<V> =>
        Effect.map(count(`semaphore.${name}`, args[0], site), (n) => lazy(() => run(n, site)));
    const within = (name: string, some: boolean) =>
      native(`semaphore.${name}`, ([given], site) =>
        Effect.map(count(`semaphore.${name}`, given, site), (n) =>
          native(`semaphore.${name}`, ([effect], at) =>
            effect?._tag === "Effect"
              ? Effect.succeed(
                  lazy(() => {
                    if (free() < n) return some ? Effect.succeed(Value.none) : semaphoreWaits(at);
                    state.taken += n;
                    // The permits go back however the effect ends.
                    return Effect.ensuring(
                      some ? Effect.map(effect.run, Value.some) : effect.run,
                      Effect.sync(() => {
                        state.taken -= n;
                      }),
                    );
                  }),
                )
              : wrongArguments(at, `semaphore.${name}`),
          ),
        ),
      );
    const withPermits = within("withPermits", false);
    const fields: Fields = {
      [IS]: Value.str("Semaphore"),
      "~withPermits": withPermits,
      "~withPermitsIfAvailable": within("withPermitsIfAvailable", true),
      "~withPermit": native("semaphore.withPermit", (args, site) =>
        Effect.flatMap(host.call(withPermits, [Value.num(1)], site), (one) =>
          host.call(one, args, site),
        ),
      ),
      "~take": native(
        "semaphore.take",
        counted("take", (n, site) => {
          if (free() < n) return semaphoreWaits(site);
          state.taken += n;
          return Effect.succeed(Value.num(n));
        }),
      ),
      "~takeIfAvailable": native(
        "semaphore.takeIfAvailable",
        counted("takeIfAvailable", (n) =>
          Effect.sync(() => {
            if (free() < n) return Value.bool(false);
            state.taken += n;
            return Value.bool(true);
          }),
        ),
      ),
      "~release": native(
        "semaphore.release",
        counted("release", (n) =>
          Effect.sync(() => {
            state.taken -= n;
            return Value.num(free());
          }),
        ),
      ),
      "~releaseAll": lazy(() =>
        Effect.sync(() => {
          state.taken = 0;
          return Value.num(free());
        }),
      ),
      "~resize": native(
        "semaphore.resize",
        counted("resize", (n) =>
          Effect.sync(() => {
            state.permits = n;
            return Value.undef;
          }),
        ),
      ),
    };
    return Value.obj(fields, REF);
  };

  /** A function of the module: the semaphore's own member, given the rest. */
  const ofSemaphore =
    (name: string, own: number): Model =>
    (args, site) => {
      // `Semaphore.take(n)` then the semaphore, where the first argument is not one.
      if (!fieldsOf("Semaphore", args[0]))
        return Effect.succeed(
          native(`Semaphore.${name}`, ([self], at) => ofSemaphore(name, own)([self!, ...args], at)),
        );
      const member = fieldsOf("Semaphore", args[0])![`~${name}`]!;
      const [, ...rest] = args;
      if (own === 0) return Effect.succeed(member);
      return Effect.flatMap(host.call(member, rest.slice(0, own), site), (given) =>
        rest.length > own ? host.call(given, rest.slice(own), site) : Effect.succeed(given),
      );
    };

  const semaphores: Models = {
    "effect/Semaphore:make": made(([permits], site) =>
      Effect.map(count("Semaphore.make", permits, site), semaphore),
    ),
    "effect/Semaphore:makeUnsafe": ([permits], site) =>
      Effect.map(count("Semaphore.makeUnsafe", permits, site), semaphore),
    "effect/Semaphore:withPermits": ofSemaphore("withPermits", 1),
    "effect/Semaphore:withPermitsIfAvailable": ofSemaphore("withPermitsIfAvailable", 1),
    "effect/Semaphore:withPermit": ([self, ...rest], site) => {
      const member = fieldsOf("Semaphore", self)?.["~withPermit"];
      if (!member) return wrongArguments(site, "Semaphore.withPermit");
      return rest.length === 0 ? Effect.succeed(member) : host.call(member, rest, site);
    },
    "effect/Semaphore:take": ofSemaphore("take", 1),
    "effect/Semaphore:takeIfAvailable": ofSemaphore("takeIfAvailable", 1),
    "effect/Semaphore:release": ofSemaphore("release", 1),
    "effect/Semaphore:resize": ofSemaphore("resize", 1),
    "effect/Semaphore:releaseAll": ofSemaphore("releaseAll", 0),
  };

  // --- Queue: what the handler offered and has not taken, in order.

  const queue = (capacity: number): V =>
    Value.obj({ [IS]: Value.str("Queue"), capacity: Value.num(capacity), items: arr([]) }, REF);

  const itemsOf = (fields: Fields): ReadonlyArray<V> =>
    fields.items?._tag === "Arr" ? fields.items.items : [];
  const capacityOf = (fields: Fields): number =>
    fields.capacity?._tag === "Num" ? fields.capacity.value : Infinity;
  const keep = (fields: Fields, items: ReadonlyArray<V>): void => {
    fields.items = arr(items);
  };

  const emptyWaits = (site: Site) => waits(site, "takes from a Queue with nothing in it");
  const fullWaits = (site: Site) => waits(site, "offers to a Queue that is full");

  const offered = (fields: Fields, value: V | undefined, site: Site): Eval<V> => {
    if (itemsOf(fields).length >= capacityOf(fields)) return fullWaits(site);
    keep(fields, [...itemsOf(fields), value ?? Value.undef]);
    return Effect.succeed(Value.bool(true));
  };

  const offeredAll = (fields: Fields, values: V | undefined, site: Site): Eval<V> => {
    const given = kit.itemsOf(values);
    if (!given) return wrongArguments(site, "Queue.offerAll");
    if (itemsOf(fields).length + given.length > capacityOf(fields)) return fullWaits(site);
    keep(fields, [...itemsOf(fields), ...given]);
    // What did not fit: nothing.
    return Effect.succeed(arr([]));
  };

  const size = (fields: Fields): V => Value.num(itemsOf(fields).length);
  const full = (fields: Fields): V => Value.bool(itemsOf(fields).length === capacityOf(fields));

  const queues: Models = {
    "effect/Queue:unbounded": made(() => Effect.sync(() => queue(Infinity))),
    "effect/Queue:bounded": made(([capacity], site) => {
      const n = whole(capacity);
      return n === undefined || n === 0
        ? Effect.fail(
            Value.notTranslated(site, "makes a Queue of a size the prover cannot see, or of none"),
          )
        : Effect.succeed(queue(n));
    }),
    "effect/Queue:offer": on("Queue", "offer", 2, (fields, [value], site) =>
      offered(fields, value, site),
    ),
    "effect/Queue:offerUnsafe": now("Queue", "offerUnsafe", 2, (fields, [value]) =>
      Effect.sync(() => {
        if (itemsOf(fields).length >= capacityOf(fields)) return Value.bool(false);
        keep(fields, [...itemsOf(fields), value ?? Value.undef]);
        return Value.bool(true);
      }),
    ),
    "effect/Queue:offerAll": on("Queue", "offerAll", 2, (fields, [values], site) =>
      offeredAll(fields, values, site),
    ),
    "effect/Queue:take": on("Queue", "take", 1, (fields, _, site) => {
      const [first, ...rest] = itemsOf(fields);
      if (!first) return emptyWaits(site);
      keep(fields, rest);
      return Effect.succeed(first);
    }),
    "effect/Queue:peek": on("Queue", "peek", 1, (fields, _, site) => {
      const [first] = itemsOf(fields);
      return first ? Effect.succeed(first) : emptyWaits(site);
    }),
    "effect/Queue:poll": on("Queue", "poll", 1, (fields) =>
      Effect.sync(() => {
        const [first, ...rest] = itemsOf(fields);
        if (!first) return Value.none;
        keep(fields, rest);
        return Value.some(first);
      }),
    ),
    "effect/Queue:takeAll": on("Queue", "takeAll", 1, (fields, _, site) => {
      const items = itemsOf(fields);
      if (items.length === 0) return emptyWaits(site);
      keep(fields, []);
      return Effect.succeed(arr(items));
    }),
    "effect/Queue:takeN": on("Queue", "takeN", 2, (fields, [count], site) => {
      const n = whole(count);
      const items = itemsOf(fields);
      if (n === undefined)
        return Effect.fail(
          Value.notTranslated(site, "calls Queue.takeN with a count the prover cannot see"),
        );
      if (items.length < n) return emptyWaits(site);
      keep(fields, items.slice(n));
      return Effect.succeed(arr(items.slice(0, n)));
    }),
    "effect/Queue:clear": on("Queue", "clear", 1, (fields) =>
      Effect.sync(() => {
        const items = itemsOf(fields);
        keep(fields, []);
        return arr(items);
      }),
    ),
    "effect/Queue:size": on("Queue", "size", 1, (fields) => Effect.sync(() => size(fields))),
    "effect/Queue:sizeUnsafe": now("Queue", "sizeUnsafe", 1, (fields) =>
      Effect.sync(() => size(fields)),
    ),
    "effect/Queue:isFull": on("Queue", "isFull", 1, (fields) => Effect.sync(() => full(fields))),
    "effect/Queue:isFullUnsafe": now("Queue", "isFullUnsafe", 1, (fields) =>
      Effect.sync(() => full(fields)),
    ),
  };

  /** The member of a latch or a semaphore the code reads: `latch.open`, `semaphore.take`. */
  const member = (value: V, key: string): V | undefined => {
    const is = value._tag === "Obj" && value.brand?.kind === "Ref" ? value.fields[IS] : undefined;
    if (is?._tag !== "Str" || (is.value !== "Latch" && is.value !== "Semaphore")) return undefined;
    return (value as { fields: Fields }).fields[`~${key}`];
  };

  const models: Models = { ...deferreds, ...latches, ...semaphores, ...queues };
  return { models, member };
};
