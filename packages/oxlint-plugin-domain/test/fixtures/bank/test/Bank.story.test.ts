import { Story } from "@alchemy.run/domain/Story";
import { NotOpen } from "../src/Account/NotOpen.rejection.ts";
import { OpenAccount } from "../src/Account/OpenAccount.command.ts";
import { MoneyWithdrawn } from "../src/Account/WithdrawMoney.command.ts";

// Sends OpenAccount, shows WithdrawMoney through its event, asserts NotOpen.
export const steps = [
  Story.when(a1, new OpenAccount({ owner: "sam" })),
  Story.then(a1, new MoneyWithdrawn({ amount: 1 })),
  Story.rejected(new NotOpen()),
];
