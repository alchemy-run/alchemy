import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";
import { Account } from "../Account/Account.aggregate.ts";
import { AccountId } from "../Account/Account.id.ts";
import { ForgetOwner } from "../Account/ForgetOwner.rewrite.ts";
import { Customer } from "./Customer.aggregate.ts";
import { CustomerId } from "./Customer.id.ts";
import { CustomerDashboard } from "./CustomerDashboard.view.ts";
import { DeleteCustomer } from "./DeleteCustomer.rewrite.ts";
import { ReleaseUsername } from "./ReleaseUsername.rewrite.ts";
import { Username } from "./Username.ts";
import { UsernameClaim } from "./UsernameClaim.aggregate.ts";

/**
 * Removes everything that identifies a customer: their name on each account
 * they opened, their username's claim, and the customer. Each step waits
 * until every view, projection and stream built from what it rewrote has
 * caught up, so the run ends only once the name is gone everywhere.
 *
 * No command of the bank starts it: the operator who handles the customer's
 * request does, with `erasures.start(customerId, {})`.
 */
export class EraseCustomer extends Domain.Saga("EraseCustomer", {
  key: CustomerId,
  input: {},
}) {}

export const EraseCustomerLive = EraseCustomer.toLayer(
  Effect.gen(function* () {
    const accounts = yield* Account;
    const customers = yield* Customer;
    const claims = yield* UsernameClaim;
    const dashboards = yield* CustomerDashboard;
    const vault = yield* Domain.Vault;

    return Effect.fn(function* ({ key }) {
      // Read before anything is removed: the steps after this one need them.
      const found = yield* Activity.make({
        name: "find",
        success: Schema.Struct({
          accounts: Schema.Array(AccountId),
          username: Schema.NullOr(Username),
        }),
        execute: Effect.gen(function* () {
          const customer = yield* customers.get(key);
          const dashboard = yield* dashboards.get(Customer.ref(key)).pipe(Effect.orDie);
          return {
            accounts: Object.keys(Option.getOrUndefined(dashboard)?.balances ?? {}).map(
              (id) => Account.ref(id).id,
            ),
            username: customer._tag === "Registered" ? customer.username : null,
          };
        }),
      });

      // The key goes first: from here on, nothing sealed for the customer opens,
      // in the model or in any copy of its events.
      yield* Activity.make({
        name: "shred-key",
        execute: vault.shred(key).pipe(Effect.orDie),
      });

      for (const accountId of found.accounts) {
        yield* Activity.make({
          name: `forget-owner:${accountId}`,
          execute: accounts
            .rewrite(accountId, new ForgetOwner({ customerId: key }))
            .pipe(Effect.flatMap(accounts.rewritten), Effect.orDie),
        });
      }

      const username = found.username;
      if (username !== null) {
        yield* Activity.make({
          name: "release-username",
          execute: claims
            .rewrite(username, new ReleaseUsername())
            .pipe(Effect.flatMap(claims.rewritten), Effect.orDie),
        });
      }

      yield* Activity.make({
        name: "delete-customer",
        execute: customers
          .rewrite(key, new DeleteCustomer())
          .pipe(Effect.flatMap(customers.rewritten), Effect.orDie),
      });
    });
  }),
);
