import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

const Units = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }));

export class Loaded extends Domain.Event("Loaded", { units: Units }) {}

export class Full extends Domain.Rejection("Full", {}) {}

export class Load extends Domain.Command("Load", {
  input: { id: Schema.String, units: Units },
  events: [Loaded],
  rejects: [Full],
}) {}

const limits = { most: 100 };
// The file changes the limit as it loads. Anyone reading `decide` sees 100,
// and so does the prover: the code that runs takes loads up to 1000.
limits.most = 1000;

/**
 * A truck that says it never holds more than 100 units. The rule is proved
 * from what `decide` reads as, and false of what it does.
 */
export class Truck extends Domain.Aggregate("Truck", {
  id: Schema.String,
  state: Schema.Struct({ held: Schema.Int }),
  initial: { held: 0 },
  commands: [Load],
  keyOf: (cmd) => cmd.id,
  invariants: {
    NeverOverloaded: (truck) => truck.held >= 0 && truck.held <= 100,
  },
  decide: {
    Load: (truck, command) =>
      truck.held + command.units > limits.most
        ? new Full()
        : [new Loaded({ units: command.units })],
  },
  evolve: {
    Loaded: (truck, event) => ({ held: truck.held + event.units }),
  },
}) {}
