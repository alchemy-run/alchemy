import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

export class WindowReset extends Domain.Event("WindowReset", { bucket: Schema.Int }) {}

export class Tick extends Domain.Command("Tick", {
  input: { id: Schema.String },
  events: [WindowReset],
}) {}

/** Counts time in minutes: the bucket is the minute the last tick fell in. */
export class Window extends Domain.Aggregate("Window", {
  id: Schema.String,
  state: Schema.Struct({ bucket: Schema.Int }),
  initial: { bucket: 0 },
  invariants: { NeverBeforeTheStart: (window) => window.bucket >= 0 },
  transitions: {
    TheBucketOnlyGrows: ({ before, after }) => after.bucket >= before.bucket,
  },
  commands: [Tick],
  keyOf: (cmd) => cmd.id,
  decide: {
    Tick: (state, _command, context) => {
      const bucket = Math.floor(DateTime.toEpochMillis(context.now) / 60_000);
      return bucket > state.bucket ? [new WindowReset({ bucket })] : [];
    },
  },
  evolve: {
    WindowReset: (state, event) => ({ ...state, bucket: event.bucket }),
  },
}) {}
