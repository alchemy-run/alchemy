import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

// One aggregate and one view definition, used by two independent models.
export class Opened extends Domain.Event("Opened", { owner: Schema.String }) {}
export class Open extends Domain.Command("Open", {
  target: Schema.String,
  input: { owner: Schema.String },
  events: [Opened],
}) {}
export class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ owner: Schema.NullOr(Schema.String) }),
  initial: { owner: null },
  commands: [Open],
  decide: { Open: (_, { owner }) => [new Opened({ owner })] },
  evolve: { Opened: (_, { owner }) => ({ owner }) },
}) {}
export class Owners extends Domain.View("Owners", {
  from: [Account],
  key: Account,
  state: Schema.Struct({ owner: Schema.String }),
  initial: { owner: "" },
  evolve: { Opened: (_, { owner }) => ({ owner }) },
}) {}

export class Billing extends Domain.Model("Billing", { aggregates: [Account], views: [Owners] }) {}
export class Audit extends Domain.Model("Audit", { aggregates: [Account], views: [Owners] }) {}
