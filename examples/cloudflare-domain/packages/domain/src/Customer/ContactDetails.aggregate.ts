import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CurrentActor } from "../CurrentActor.context.ts";
import { Address } from "./Address.ts";
import { CustomerId } from "./Customer.id.ts";
import { AddressSet, NotYourAddress, SetAddress } from "./SetAddress.command.ts";

/**
 * How to reach a customer. Everything it records is sealed under the
 * customer's key, so shredding that key is all it takes to forget it.
 */
export class ContactDetails extends Domain.Aggregate("ContactDetails", {
  id: CustomerId,
  state: Schema.Struct({ address: Schema.NullOr(Address) }),
  initial: { address: null },
  commands: [SetAddress],
  keyOf: (cmd) => cmd.customerId,
  transitions: {
    /** An address is only ever sealed under the key of the customer it belongs to. */
    AnAddressIsSealedForItsCustomer: ({ command, after }) =>
      after.address === null || after.address.subject === command.customerId,
  },
  decide: {
    SetAddress: Effect.fn(function* (_, cmd) {
      const actor = yield* CurrentActor;
      if (actor._tag === "Customer" && actor.customerId !== cmd.customerId) {
        return yield* new NotYourAddress();
      }
      // The subject names whose key seals the value: it must be this customer's.
      if (cmd.address.subject !== cmd.customerId) return yield* new NotYourAddress();
      return [new AddressSet({ address: cmd.address })];
    }),
  },
  evolve: {
    AddressSet: (_, e) => ({ address: e.address }),
  },
}) {}
