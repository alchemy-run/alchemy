import * as Domain from "@alchemy.run/domain";
import { BroughtForward, Deposited, Opened, Summed, Vault } from "./Vault.aggregate.ts";

/** Carries the whole state: nothing is lost. */
export class BringForward extends Domain.Compaction("BringForward", {
  of: Vault,
  rollup: (vault) => [new BroughtForward({ state: vault })],
}) {}

/** Leaves out how many deposits there were: a vault that had any is not what it was. */
export class SumUp extends Domain.Compaction("SumUp", {
  of: Vault,
  rollup: (vault) => [new Summed({ owner: vault.owner, balance: vault.balance })],
}) {}

/** Changes who a vault belongs to, and nothing the rules speak of. */
export class ForgetOwner extends Domain.Rewrite("ForgetOwner", {
  of: Vault,
  events: {
    Opened: (event) => new Opened({ ...event, owner: "" }),
    BroughtForward: (event) => new BroughtForward({ state: { ...event.state, owner: "" } }),
  },
}) {}

/** Removes every deposit: a withdrawal the deposits paid for now overdraws. */
export class DropDeposits extends Domain.Rewrite("DropDeposits", {
  of: Vault,
  events: { Deposited: () => null },
}) {}

/** Doubles every deposit: more money, and no rule is broken. */
export class DoubleDeposits extends Domain.Rewrite("DoubleDeposits", {
  of: Vault,
  events: { Deposited: (event) => new Deposited({ amount: event.amount * 2 }) },
}) {}

export class DeleteVault extends Domain.Rewrite("DeleteVault", { of: Vault, delete: true }) {}
