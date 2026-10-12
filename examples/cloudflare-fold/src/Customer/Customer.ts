import { Aggregate } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { CustomerId } from "./CustomerId.ts";
import { AlreadyRegistered, CustomerRegistered, Register } from "./Register.ts";

export class Customer extends Aggregate.make("Customer", {
  id: CustomerId,
  state: Schema.Union([
    Schema.TaggedStruct("New", {}),
    Schema.TaggedStruct("Registered", { name: Schema.String }),
  ]),
  initial: { _tag: "New" },
  commands: [Register],
  decide: {
    Register: (s, cmd) =>
      s._tag === "Registered"
        ? new AlreadyRegistered()
        : [new CustomerRegistered({ name: cmd.name })],
  },
  evolve: {
    CustomerRegistered: (_, e) => ({ _tag: "Registered" as const, name: e.name }),
  },
}) {}
