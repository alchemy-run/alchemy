import * as Schema from "effect/Schema";
import { CustomerId } from "./CustomerId.ts";

/**
 * Who is acting. `Session` provides it as the `CurrentActor` of each
 * request; a transfer records it, so the saga debits on the requester's behalf.
 */
export const Actor = Schema.Union([
  Schema.TaggedStruct("Customer", { customerId: CustomerId }),
  Schema.TaggedStruct("System", { name: Schema.String }),
]);
export type Actor = typeof Actor.Type;

export const customer = (customerId: string): Actor => ({
  _tag: "Customer",
  customerId: CustomerId.make(customerId),
});
export const system = (name: string): Actor => ({ _tag: "System", name });
