import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

const Amount = Schema.BigInt.check(Schema.isGreaterThanBigInt(0n));

export class VaultChanged extends Domain.Event("VaultChanged", { cents: Schema.BigInt }) {}

export class TooLittle extends Domain.Rejection("TooLittle", {}) {}

export class Store extends Domain.Command("Store", {
  input: { id: Schema.String, amount: Amount },
  events: [VaultChanged],
}) {}

export class Take extends Domain.Command("Take", {
  input: { id: Schema.String, amount: Amount },
  events: [VaultChanged],
  rejects: [TooLittle],
}) {}

export class Halve extends Domain.Command("Halve", {
  input: { id: Schema.String },
  events: [VaultChanged],
}) {}

export class Charge extends Domain.Command("Charge", {
  input: { id: Schema.String },
  events: [VaultChanged],
}) {}

/** Holds more cents than a number can count. */
export class Vault extends Domain.Aggregate("Vault", {
  id: Schema.String,
  state: Schema.Struct({ cents: Schema.BigInt }),
  initial: { cents: 0n },
  invariants: { NeverNegative: (vault) => vault.cents >= 0n },
  commands: [Store, Take, Halve, Charge],
  keyOf: (cmd) => cmd.id,
  decide: {
    Store: (state, command) => [new VaultChanged({ cents: state.cents + command.amount })],
    Take: (state, command) =>
      state.cents >= command.amount
        ? [new VaultChanged({ cents: state.cents - command.amount })]
        : new TooLittle({}),
    Halve: (state) => (state.cents > 1n ? [new VaultChanged({ cents: state.cents / 2n })] : []),
    // A fee of one cent, taken even from an empty vault.
    Charge: (state) => [new VaultChanged({ cents: state.cents - 1n })],
  },
  evolve: {
    VaultChanged: (state, event) => ({ ...state, cents: event.cents }),
  },
}) {}
