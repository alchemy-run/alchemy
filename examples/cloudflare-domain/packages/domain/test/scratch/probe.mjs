import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
const show = (name, eff) => {
  let out;
  try {
    const exit = Effect.runSyncExit(eff);
    out = Exit.isSuccess(exit)
      ? "ok " + JSON.stringify(exit.value)
      : "FAIL " + String(exit.cause).slice(0, 110);
  } catch (e) {
    out = "THROW " + String(e).slice(0, 100);
  }
  console.log(name.padEnd(34), out);
};
const g = (f) => Effect.gen(f);
show("sleep", Effect.sleep("1 millis"));
show("sleep 0", Effect.sleep(0));
show("delay", Effect.delay(Effect.succeed(1), "1 millis"));
show("yieldNow", Effect.yieldNow);
show(
  "retry recurs",
  g(function* () {
    const r = yield* Ref.make(0);
    return yield* Effect.retry(
      Effect.flatMap(
        Ref.updateAndGet(r, (n) => n + 1),
        (n) => (n < 3 ? Effect.fail(n) : Effect.succeed(n)),
      ),
      Schedule.recurs(5),
    );
  }),
);
show(
  "retry {schedule recurs}",
  g(function* () {
    const r = yield* Ref.make(0);
    return yield* Effect.retry(
      Effect.flatMap(
        Ref.updateAndGet(r, (n) => n + 1),
        (n) => (n < 3 ? Effect.fail(n) : Effect.succeed(n)),
      ),
      { schedule: Schedule.recurs(5) },
    );
  }),
);
show(
  "repeat recurs",
  g(function* () {
    const r = yield* Ref.make(0);
    const out = yield* Effect.repeat(
      Ref.updateAndGet(r, (n) => n + 1),
      Schedule.recurs(2),
    );
    return [out, yield* Ref.get(r)];
  }),
);
show(
  "fork+join",
  g(function* () {
    const f = yield* Effect.forkChild(Effect.succeed(1));
    return yield* Fiber.join(f);
  }),
);
show(
  "fork only",
  g(function* () {
    const r = yield* Ref.make(0);
    yield* Effect.forkChild(Ref.set(r, 5));
    return yield* Ref.get(r);
  }),
);
show("race", Effect.race(Effect.succeed(1), Effect.succeed(2)));
show("all concurrent", Effect.all([Effect.succeed(1), Effect.succeed(2)], { concurrency: 2 }));
show(
  "forEach concurrent",
  Effect.forEach([1, 2], (n) => Effect.succeed(n + 1), { concurrency: "unbounded" }),
);
show(
  "deferred",
  g(function* () {
    const d = yield* Deferred.make();
    const a = yield* Deferred.succeed(d, 1);
    const b = yield* Deferred.succeed(d, 2);
    return [a, b, yield* Deferred.await(d), yield* Deferred.isDone(d)];
  }),
);
show(
  "deferred await pending",
  g(function* () {
    const d = yield* Deferred.make();
    return yield* Deferred.await(d);
  }),
);
show(
  "deferred poll",
  g(function* () {
    const d = yield* Deferred.make();
    return Option.isNone(yield* Deferred.poll(d));
  }),
);
show(
  "queue",
  g(function* () {
    const q = yield* Queue.unbounded();
    yield* Queue.offer(q, 1);
    yield* Queue.offerAll(q, [2, 3]);
    return [yield* Queue.take(q), yield* Queue.size(q), yield* Queue.takeAll(q)];
  }),
);
show(
  "queue take empty",
  g(function* () {
    const q = yield* Queue.unbounded();
    return yield* Queue.take(q);
  }),
);
show(
  "queue bounded full",
  g(function* () {
    const q = yield* Queue.bounded(1);
    yield* Queue.offer(q, 1);
    return yield* Queue.offer(q, 2);
  }),
);
show(
  "semaphore",
  g(function* () {
    const s = yield* Semaphore.make(1);
    return yield* s.withPermits(1)(Effect.succeed(7));
  }),
);
show(
  "semaphore over",
  g(function* () {
    const s = yield* Semaphore.make(1);
    return yield* s.withPermits(2)(Effect.succeed(7));
  }),
);
show(
  "latch open",
  g(function* () {
    const l = yield* Latch.make(false);
    yield* l.open;
    yield* l.await;
    return 1;
  }),
);
show(
  "latch closed",
  g(function* () {
    const l = yield* Latch.make(false);
    yield* l.await;
    return 1;
  }),
);
show(
  "subref changes take1",
  g(function* () {
    const c = yield* SubscriptionRef.make(4);
    return yield* Stream.runCollect(Stream.take(SubscriptionRef.changes(c), 1));
  }),
);
show("timeout", Effect.timeout(Effect.succeed(1), "1 second"));
