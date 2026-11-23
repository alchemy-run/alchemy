import { randomUUID } from "node:crypto";
import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/** The time now, as text: a new value each call. */
export const now = () => new Date().toISOString();

/** A random id: a new value each call. */
export const fresh = () => randomUUID();

export class Pressed extends Domain.Event("Pressed", {}) {}

export class Sealed extends Domain.Event("Sealed", {}) {}

export class Press extends Domain.Command("Press", {
  input: { target: Schema.String },
  events: [Pressed],
}) {}

export class Seal extends Domain.Command("Seal", {
  input: { target: Schema.String },
  events: [Sealed],
}) {}

/**
 * A stamp whose fold calls helpers that are not functions of their arguments.
 * Its rule holds only if two calls of a helper give one value, which they do
 * not.
 */
export class Stamp extends Domain.Aggregate("Stamp", {
  id: Schema.String,
  state: Schema.Struct({ mark: Schema.String, copy: Schema.String }),
  initial: { mark: "", copy: "" },
  commands: [Press, Seal],
  keyOf: (command) => command.target,
  invariants: {
    TheCopyIsTheMark: (stamp) => stamp.copy === stamp.mark,
  },
  decide: {
    Press: () => [new Pressed({})],
    Seal: () => [new Sealed({})],
  },
  evolve: {
    Pressed: () => ({ mark: now(), copy: now() }),
    Sealed: () => ({ mark: fresh(), copy: fresh() }),
  },
}) {}
