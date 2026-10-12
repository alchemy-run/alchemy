import { Aggregate } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CurrentActor } from "../CurrentActor.ts";
import { CustomerId } from "./CustomerId.ts";
import {
  AlreadyRegistered,
  CustomerRegistered,
  NotTheCustomer,
  RegisterCustomer,
} from "./RegisterCustomer.ts";

export class Customer extends Aggregate.make("Customer", {
  id: CustomerId,
  state: Schema.Union([
    Schema.TaggedStruct("New", {}),
    Schema.TaggedStruct("Registered", { name: Schema.String }),
  ]),
  initial: { _tag: "New" },
  commands: [RegisterCustomer],
  decide: {
    RegisterCustomer: Effect.fn(function* (s, cmd, { id }) {
      const actor = yield* CurrentActor;
      if (actor._tag === "Customer" && actor.customerId !== id) return yield* new NotTheCustomer();
      if (s._tag === "Registered") return yield* new AlreadyRegistered();
      return [new CustomerRegistered({ name: cmd.name })];
    }),
  },
  evolve: {
    CustomerRegistered: (_, e) => ({ _tag: "Registered" as const, name: e.name }),
  },
}) {}
