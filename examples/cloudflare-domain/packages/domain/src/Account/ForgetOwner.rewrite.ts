import * as Domain from "@alchemy.run/domain";
import { CustomerId } from "../Customer/Customer.id.ts";
import { Account } from "./Account.aggregate.ts";
import { AccountOpened } from "./OpenAccount.command.ts";

/** Removes a customer's name from an account they opened. What the account did stays. */
export class ForgetOwner extends Domain.Rewrite("ForgetOwner", {
  of: Account,
  input: { customerId: CustomerId },
  events: {
    AccountOpened: (event, { customerId }) =>
      event.customerId === customerId ? new AccountOpened({ ...event, owner: "" }) : event,
  },
}) {}
