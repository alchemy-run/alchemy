import { Mutation } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Account } from "../Account/Account.ts";
import { AccountId, mainAccountId } from "../Account/AccountId.ts";
import { AccountSummary } from "../Account/AccountSummary.ts";
import { AlreadyRegistered, Customer, Register } from "../Customer/Customer.ts";
import { CustomerId } from "../Customer/CustomerId.ts";
import { CurrentCustomer } from "./CurrentCustomer.ts";
import { CustomerSession } from "./CustomerSession.ts";

/** Register the signed-in customer and wait for their main account to open. */
export class RegisterCustomer extends Mutation.make("register", {
  input: { name: Schema.String },
  output: { customerId: CustomerId, accountId: AccountId },
  errors: [AlreadyRegistered],
}).middleware(CustomerSession) {}

export const RegisterCustomerLive = RegisterCustomer.toLayer(
  Effect.gen(function* () {
    const customers = yield* Customer;
    const summaries = yield* AccountSummary;
    return Effect.fn(function* ({ name }) {
      const { customerId } = yield* CurrentCustomer;
      yield* customers.send(customerId, new Register({ name }));
      const accountId = mainAccountId(customerId);
      // The main account is opened by a policy, so wait for its view.
      yield* summaries
        .waitFor(Account.ref(accountId), { owner: { not: null } }, { timeout: "10 seconds" })
        .pipe(Effect.catchTag("WaitTimeout", () => Effect.void));
      return { customerId, accountId };
    });
  }),
);
