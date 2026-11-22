import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { CustomerId } from "./Customer.id.ts";
import { UsernameClaimed } from "./RegisterCustomer.command.ts";
import { Username } from "./Username.ts";

/**
 * One username, and who holds it. Uniqueness spans every customer, so the
 * invariant has an aggregate of its own, keyed by the username: every
 * registration that asks for a name reads this one instance.
 */
export class UsernameClaim extends Domain.Aggregate("UsernameClaim", {
  id: Username,
  state: Schema.Union([
    Schema.TaggedStruct("Free", {}),
    Schema.TaggedStruct("Claimed", { customerId: CustomerId }),
  ]),
  initial: { _tag: "Free" },
  transitions: {
    /** Once somebody holds a name, nobody else gets it. */
    AClaimedNameStaysWithItsHolder: ({ before, after }) =>
      before._tag === "Free" ||
      (after._tag === "Claimed" && after.customerId === before.customerId),
  },
  events: [UsernameClaimed],
  evolve: {
    UsernameClaimed: (_, e) => ({ _tag: "Claimed" as const, customerId: e.customerId }),
  },
}) {}
