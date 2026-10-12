import { Policy } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import { Account } from "../Account/Account.ts";
import { mainAccountId } from "../Account/AccountId.ts";
import { OpenAccount } from "../Account/OpenAccount.ts";
import { Customer } from "./Customer.ts";
import { CustomerRegistered } from "./RegisterCustomer.ts";

/** Whenever a customer registers, open their main account. */
export class MainAccountProvisioning extends Policy.make("MainAccountProvisioning", {
  from: Customer,
  on: [CustomerRegistered],
}) {}

export const MainAccountProvisioningLive = MainAccountProvisioning.toLayer(
  Effect.gen(function* () {
    const accounts = yield* Account;
    return Effect.fn(function* ({ source, event }) {
      yield* accounts
        .send(
          mainAccountId(source.id),
          new OpenAccount({ customerId: source.id, owner: event.name }),
        )
        .pipe(Effect.catchTag("AlreadyOpen", () => Effect.void));
    });
  }),
);
