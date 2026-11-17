import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { CurrentActor } from "../CurrentActor.context.ts";
import { Customer } from "./Customer.aggregate.ts";
import {
  AlreadyRegistered,
  CustomerRegistered,
  NotTheCustomer,
  RegisterCustomer,
  UsernameClaimed,
  UsernameTaken,
} from "./RegisterCustomer.command.ts";
import { UsernameClaim } from "./UsernameClaim.aggregate.ts";

/**
 * Register a customer and claim their username together. Both are recorded,
 * or neither is: a taken username rejects the registration, and two
 * customers who ask for one name at the same moment can't both get it.
 */
export class Registration extends Domain.Decision(RegisterCustomer, {
  reads: { customer: Customer, claim: UsernameClaim },
  keyOf: (cmd) => ({ customer: cmd.customerId, claim: cmd.username }),
  decide: Effect.fn(function* ({ customer, claim }, cmd) {
    const actor = yield* CurrentActor;
    if (actor._tag === "Customer" && actor.customerId !== customer.id) {
      return yield* new NotTheCustomer();
    }
    if (customer.state._tag === "Registered") return yield* new AlreadyRegistered();
    if (claim.state._tag === "Claimed") return yield* new UsernameTaken();
    return [
      customer.record(new CustomerRegistered({ name: cmd.name, username: cmd.username })),
      claim.record(new UsernameClaimed({ customerId: customer.id })),
    ];
  }),
}) {}
