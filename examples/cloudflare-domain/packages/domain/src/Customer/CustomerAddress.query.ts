import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CurrentActor } from "../CurrentActor.context.ts";
import { Forbidden } from "../Forbidden.rejection.ts";
import { Session } from "../Session.middleware.ts";
import { Address } from "./Address.ts";
import { ContactDetails } from "./ContactDetails.aggregate.ts";
import { CustomerId } from "./Customer.id.ts";

/**
 * A customer's address, opened for the customer or an agent. It is `null`
 * when none was set, and once the customer's key is shredded.
 */
export class CustomerAddress extends Domain.Query("CustomerAddress", {
  input: { customerId: CustomerId },
  success: Schema.Struct({ address: Schema.NullOr(Schema.String) }),
  middleware: [Session],
  rejects: [Forbidden],
}) {}

/** Checks who is asking, then opens the sealed address with the Vault. */
export const CustomerAddressLive = CustomerAddress.toLayer(
  Effect.gen(function* () {
    const vault = yield* Domain.Vault;
    const contacts = yield* ContactDetails;
    return Effect.fn(function* ({ customerId }) {
      const actor = yield* CurrentActor;
      if (actor._tag === "Customer" && actor.customerId !== customerId) {
        return yield* new Forbidden({ reason: "that is not your address" });
      }
      const { address } = yield* contacts.get(customerId);
      if (address === null) return { address: null };
      const opened = yield* vault.open(Address, address).pipe(Effect.orDie);
      return { address: Option.getOrNull(opened) };
    });
  }),
);
