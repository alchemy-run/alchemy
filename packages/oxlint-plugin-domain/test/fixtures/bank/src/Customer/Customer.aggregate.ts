import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { CustomerId } from "./Customer.id.ts";

export class Customer extends Domain.Aggregate("Customer", {
  id: CustomerId,
  state: Schema.Struct({}),
  initial: {},
  commands: [],
  decide: {},
  evolve: {},
}) {}
