import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { CustomerId } from "./Customer.id.ts";
import { CustomerRegistered } from "./RegisterCustomer.command.ts";
import { Username } from "./Username.ts";

/**
 * A customer. It decides nothing alone: registering involves the username
 * too, so `Registration` decides it and records `CustomerRegistered` here.
 */
export class Customer extends Domain.Aggregate("Customer", {
  id: CustomerId,
  state: Schema.Union([
    Schema.TaggedStruct("New", {}),
    Schema.TaggedStruct("Registered", { name: Schema.String, username: Username }),
  ]),
  initial: { _tag: "New" },
  events: [CustomerRegistered],
  evolve: {
    CustomerRegistered: (_, e) => ({
      _tag: "Registered" as const,
      name: e.name,
      username: e.username,
    }),
  },
}) {}
