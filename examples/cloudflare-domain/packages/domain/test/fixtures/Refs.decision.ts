import * as Domain from "@alchemy.run/domain";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { countOf, nameOf, partsOf, versionOf } from "./refs.ts";

const Amount = Schema.Int.check(Schema.isGreaterThan(0));

export class Debited extends Domain.Event("Debited", { amount: Schema.Int }) {}
export class Credited extends Domain.Event("Credited", { amount: Schema.Int }) {}

export class Short extends Domain.Rejection("Short") {}
export class SelfPay extends Domain.Rejection("SelfPay") {}
export class BadRef extends Domain.Rejection("BadRef") {}

/** An account only decisions record on. */
export class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Int }),
  initial: { balance: 0 },
  invariants: { NeverOverdrawn: (account) => account.balance >= 0 },
  events: [Debited, Credited],
  evolve: {
    Debited: (account, event) => ({ balance: account.balance - event.amount }),
    Credited: (account, event) => ({ balance: account.balance + event.amount }),
  },
}) {}

const input = { from: Schema.String, to: Schema.String, amount: Amount };
const pay = <Tag extends string>(tag: Tag, more: Schema.Struct.Fields = {}) =>
  Domain.Command(tag, {
    input: { ...input, ...more },
    events: [Debited, Credited],
    rejects: [Short, SelfPay, BadRef],
  });

export class PayRef extends pay("PayRef") {}
export class PayNamed extends pay("PayNamed", { payee: Schema.String }) {}
export class PayVersioned extends pay("PayVersioned", { ref: Schema.String }) {}
export class PayAtVersion extends pay("PayAtVersion", { ref: Schema.String }) {}
export class PayMany extends pay("PayMany") {}
export class PayCounted extends pay("PayCounted") {}
export class PayBlind extends pay("PayBlind") {}

const moved = <A, B>(
  from: { readonly record: (event: Debited) => A },
  to: { readonly record: (event: Credited) => B },
  amount: number,
) => [from.record(new Debited({ amount })), to.record(new Credited({ amount }))];

/** The instances are the ones the ids name: a key is what `nameOf` gives. */
export class PayByRef extends Domain.Decision(PayRef, {
  reads: { from: Account, to: Account },
  keyOf: (cmd) => ({ from: nameOf(cmd.from), to: nameOf(cmd.to) }),
  decide: ({ from, to }, cmd) =>
    cmd.amount > from.state.balance ? new Short() : moved(from, to, cmd.amount),
}) {}

/** What `nameOf` gives is compared with an instance's id. */
export class PayIfNamed extends Domain.Decision(PayNamed, {
  reads: { from: Account, to: Account },
  keyOf: (cmd) => ({ from: cmd.from, to: cmd.to }),
  decide: ({ from, to }, cmd) =>
    nameOf(cmd.payee) === from.id
      ? new SelfPay()
      : cmd.amount > from.state.balance
        ? new Short()
        : moved(from, to, cmd.amount),
}) {}

/** What `versionOf` gives is tested as the `Option` it is. */
export class PayIfVersioned extends Domain.Decision(PayVersioned, {
  reads: { from: Account, to: Account },
  keyOf: (cmd) => ({ from: cmd.from, to: cmd.to }),
  decide: ({ from, to }, cmd) =>
    Option.isNone(versionOf(cmd.ref))
      ? new BadRef()
      : cmd.amount > from.state.balance
        ? new Short()
        : moved(from, to, cmd.amount),
}) {}

/** What the `Option` holds is compared with a number: only a version of at least one pays. */
export class PayFromVersion extends Domain.Decision(PayAtVersion, {
  reads: { from: Account, to: Account },
  keyOf: (cmd) => ({ from: cmd.from, to: cmd.to }),
  decide: ({ from, to }, cmd) =>
    versionOf(cmd.ref).pipe(
      Option.filter((version) => version >= 1),
      Option.match({
        onNone: () => new BadRef(),
        onSome: () => (cmd.amount > from.state.balance ? new Short() : moved(from, to, cmd.amount)),
      }),
    ),
}) {}

/** What `partsOf` gives is a list of ids: one instance for each. */
export class PayOut extends Domain.Decision(PayMany, {
  reads: { from: Account, to: Account },
  keyOf: (cmd) => ({ from: cmd.from, to: [...partsOf(cmd.to)] }),
  decide: ({ from, to }, cmd) =>
    cmd.amount * to.length > from.state.balance
      ? new Short()
      : to.flatMap((account) => moved(from, account, cmd.amount)),
}) {}

/** What `countOf` gives is a number the decision compares: it pays one account, or none. */
export class PayByCount extends Domain.Decision(PayCounted, {
  reads: { from: Account, to: Account },
  keyOf: (cmd) => ({ from: cmd.from, to: cmd.to }),
  decide: ({ from, to }, cmd) =>
    countOf(cmd.to) < 1 || countOf(cmd.to) > 1 || cmd.amount > from.state.balance
      ? new Short()
      : moved(from, to, cmd.amount),
}) {}

/** Forgets the balance: whatever `nameOf` gives, the account it names is overdrawn. */
export class PayUnchecked extends Domain.Decision(PayBlind, {
  reads: { from: Account, to: Account },
  keyOf: (cmd) => ({ from: nameOf(cmd.from), to: nameOf(cmd.to) }),
  decide: ({ from, to }, cmd) => moved(from, to, cmd.amount),
}) {}

export class PayHalved extends pay("PayHalved") {}

/** Reads inside what `nameOf` gives: its length is not something the prover has. */
export class PayByLength extends Domain.Decision(PayHalved, {
  reads: { from: Account, to: Account },
  keyOf: (cmd) => ({ from: cmd.from, to: cmd.to }),
  decide: ({ from, to }, cmd) =>
    nameOf(cmd.to).length + cmd.amount > from.state.balance
      ? new Short()
      : moved(from, to, cmd.amount),
}) {}
