import * as Domain from "@alchemy.run/domain";
import { BroughtForward, Deposited, Opened, Summed, Coffer } from "./Coffer.aggregate.ts";

/** Carries the whole state: nothing is lost. */
export class BringForward extends Domain.Compaction("BringForward", {
  of: Coffer,
  rollup: (coffer) => [new BroughtForward({ state: coffer })],
}) {}

/** Leaves out how many deposits there were: a coffer that had any is not what it was. */
export class SumUp extends Domain.Compaction("SumUp", {
  of: Coffer,
  rollup: (coffer) => [new Summed({ owner: coffer.owner, balance: coffer.balance })],
}) {}

/** Changes who a coffer belongs to, and nothing the rules speak of. */
export class ForgetOwner extends Domain.Rewrite("ForgetOwner", {
  of: Coffer,
  events: {
    Opened: (event) => new Opened({ ...event, owner: "" }),
    BroughtForward: (event) => new BroughtForward({ state: { ...event.state, owner: "" } }),
  },
}) {}

/** Removes every deposit: a withdrawal the deposits paid for now overdraws. */
export class DropDeposits extends Domain.Rewrite("DropDeposits", {
  of: Coffer,
  events: { Deposited: () => null },
}) {}

/** Doubles every deposit: more money, and no rule is broken. */
export class DoubleDeposits extends Domain.Rewrite("DoubleDeposits", {
  of: Coffer,
  events: { Deposited: (event) => new Deposited({ amount: event.amount * 2 }) },
}) {}

export class DeleteCoffer extends Domain.Rewrite("DeleteCoffer", { of: Coffer, delete: true }) {}
