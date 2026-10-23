import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { AccountId } from "./Account.id.ts";
import { AccountOpened, AlreadyOpen, OpenAccount } from "./OpenAccount.command.ts";

export class Account extends Domain.Aggregate("Account", {
  id: AccountId,
  state: Schema.Struct({ open: Schema.Boolean }),
  initial: { open: false },
  commands: [OpenAccount],
  decide: {
    OpenAccount: (s, cmd) =>
      s.open ? new AlreadyOpen() : [new AccountOpened({ owner: cmd.owner })],
  },
  evolve: { AccountOpened: () => ({ open: true }) },
}) {}
