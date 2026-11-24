import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
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
  console.log(name.padEnd(40), out);
};
const rep = (opts) =>
  Effect.gen(function* () {
    const r = yield* Ref.make(10);
    const out = yield* Effect.repeat(
      Ref.updateAndGet(r, (n) => n + 1),
      opts,
    );
    return [out, yield* Ref.get(r)];
  });
const ret = (opts) =>
  Effect.gen(function* () {
    const r = yield* Ref.make(0);
    const out = yield* Effect.result(
      Effect.retry(
        Effect.flatMap(
          Ref.updateAndGet(r, (n) => n + 1),
          (n) => (n < 4 ? Effect.fail(n) : Effect.succeed(n)),
        ),
        opts,
      ),
    );
    return [out, yield* Ref.get(r)];
  });
show("repeat recurs(2)", rep(Schedule.recurs(2)));
show("repeat recurs(0)", rep(Schedule.recurs(0)));
show("repeat {schedule recurs(2)}", rep({ schedule: Schedule.recurs(2) }));
show("repeat {schedule recurs(5), times 2}", rep({ schedule: Schedule.recurs(5), times: 2 }));
show("repeat {schedule recurs(1), times 4}", rep({ schedule: Schedule.recurs(1), times: 4 }));
show(
  "repeat {schedule recurs(5), until}",
  rep({ schedule: Schedule.recurs(5), until: (n) => n === 12 }),
);
show("repeat {times 2}", rep({ times: 2 }));
show("retry recurs(2)", ret(Schedule.recurs(2)));
show("retry recurs(5)", ret(Schedule.recurs(5)));
show("retry {schedule recurs(5), times 1}", ret({ schedule: Schedule.recurs(5), times: 1 }));
show("retry {schedule recurs(1), times 5}", ret({ schedule: Schedule.recurs(1), times: 5 }));
show(
  "retry {schedule recurs(5), while}",
  ret({ schedule: Schedule.recurs(5), while: (n) => n < 2 }),
);
