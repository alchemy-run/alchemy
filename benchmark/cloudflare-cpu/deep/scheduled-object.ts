import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { ensureAlarmTables } from "../../../packages/alchemy/src/Cloudflare/Workers/DurableObjectAlarmStorage";
import {
  scheduledExpected,
  scheduledId,
  scheduledNow,
  scheduledPayload,
  scheduledRepeatMs,
} from "./scheduled-fixture.ts";

const validCount = (count: number) => count === 100 || count === 1000;

/** A dedicated actor; preparation and processing are separate invocations. */
export class ScheduledObject extends Cloudflare.DurableObject<ScheduledObject>()(
  "DeepScheduledObject",
  Effect.succeed(
    Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const actorId = state.id.toString();
      return {
        prepare: (count: number) =>
          Effect.gen(function* () {
            if (!validCount(count))
              return yield* Effect.die(new Error("Scheduled count must be 100 or 1000"));
            yield* ensureAlarmTables(state.raw.storage);
            yield* Effect.sync(() =>
              state.raw.storage.transactionSync(() => {
                state.raw.storage.sql.exec("DELETE FROM alchemy_scheduled_events");
                state.raw.storage.sql.exec("DELETE FROM alchemy_alarm_callbacks");
                for (let index = 0; index < count; index++) {
                  state.raw.storage.sql.exec(
                    "INSERT INTO alchemy_scheduled_events (id, run_at, repeat_ms, payload) VALUES (?, ?, ?, ?)",
                    scheduledId(index),
                    scheduledNow - count + index,
                    index % 2 === 0 ? scheduledRepeatMs : null,
                    JSON.stringify({ index, text: scheduledPayload }),
                  );
                }
              }),
            );
            // The oldest event is due only under the simulated year-2100 clock.
            // Native automatic alarms remain far in the future throughout the run.
            yield* state.storage.setAlarm(scheduledNow - count);
            const nextAlarm = yield* state.storage.getAlarm();
            if (nextAlarm !== scheduledNow - count)
              return yield* Effect.die(new Error("Preparation alarm mismatch"));
            return { actorId, count, prepared: true, seeded: count, now: scheduledNow, nextAlarm };
          }),
        drain: (count: number) =>
          Effect.gen(function* () {
            if (!validCount(count))
              return yield* Effect.die(new Error("Scheduled count must be 100 or 1000"));
            const clock = yield* Clock.Clock;
            const futureClock: Clock.Clock = {
              currentTimeMillisUnsafe: () => scheduledNow,
              currentTimeMillis: Effect.succeed(scheduledNow),
              currentTimeNanosUnsafe: () => BigInt(scheduledNow) * 1_000_000n,
              currentTimeNanos: Effect.succeed(BigInt(scheduledNow) * 1_000_000n),
              monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
              monotonicTimeNanos: clock.monotonicTimeNanos,
              sleep: (duration) => clock.sleep(duration),
            };
            // Exercise the public production scheduler and its actual async storage
            // transaction. Only its wall-clock input is overridden.
            const fired = yield* Cloudflare.processScheduledEvents.pipe(
              Effect.provideService(Clock.Clock, futureClock),
              Effect.provideService(Cloudflare.DurableObjectState, state),
            );
            if (fired.length !== count)
              return yield* Effect.die(new Error("Scheduled fixture was not prepared"));
            let checksum = 0;
            let orderedChecksum = 0;
            let payloadChecksum = 0;
            for (let index = 0; index < fired.length; index++) {
              const event = fired[index]!;
              const payload = event.payload as { index?: unknown; text?: unknown } | null;
              if (
                event.id !== scheduledId(index) ||
                event.runAt.getTime() !== scheduledNow - count + index ||
                event.repeatMs !== (index % 2 === 0 ? scheduledRepeatMs : undefined) ||
                payload?.index !== index ||
                payload?.text !== scheduledPayload
              ) {
                return yield* Effect.die(new Error("Scheduled event order/payload mismatch"));
              }
              checksum += index + 1;
              orderedChecksum += (index + 1) ** 2;
              payloadChecksum += index + scheduledPayload.length;
            }
            const remainingRows = yield* Effect.sync(() =>
              state.raw.storage.sql
                .exec<{
                  id: string;
                  run_at: number;
                  repeat_ms: number;
                  payload: string;
                }>(
                  "SELECT id, run_at, repeat_ms, payload FROM alchemy_scheduled_events ORDER BY id",
                )
                .toArray(),
            );
            const expected = scheduledExpected(count);
            if (
              remainingRows.length !== expected.remaining ||
              remainingRows.some((row, position) => {
                const index = position * 2;
                return (
                  row.id !== scheduledId(index) ||
                  row.run_at !== expected.nextAlarm ||
                  row.repeat_ms !== scheduledRepeatMs ||
                  row.payload !== JSON.stringify({ index, text: scheduledPayload })
                );
              })
            )
              return yield* Effect.die(new Error("Scheduled remaining rows mismatch"));
            const nextAlarm = yield* state.storage.getAlarm();
            if (
              nextAlarm !== expected.nextAlarm ||
              checksum !== expected.checksum ||
              orderedChecksum !== expected.orderedChecksum ||
              payloadChecksum !== expected.payloadChecksum
            )
              return yield* Effect.die(new Error("Scheduled aggregate/alarm mismatch"));
            return { ...expected, actorId, checksum, orderedChecksum, payloadChecksum, nextAlarm };
          }),
      };
    }),
  ),
) {}
