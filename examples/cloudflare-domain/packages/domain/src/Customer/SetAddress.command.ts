import * as Domain from "@alchemy.run/domain";
import { Session } from "../Session.middleware.ts";
import { Address } from "./Address.ts";
import { CustomerId } from "./Customer.id.ts";

/** A customer may only set their own address, sealed under their own key. */
export class NotYourAddress extends Domain.Rejection("NotYourAddress") {}

export class AddressSet extends Domain.Event("AddressSet", { address: Address }) {}

/** Tell the bank where a customer lives. */
export class SetAddress extends Domain.Command("SetAddress", {
  middleware: [Session],
  input: { customerId: CustomerId, address: Address },
  events: [AddressSet],
  rejects: [NotYourAddress],
}) {}
