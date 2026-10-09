import * as Context from "effect/Context";
import type { CustomerId } from "../Customer/CustomerId.ts";

/** The authenticated customer making a request. Provided by {@link CustomerSession}. */
export class CurrentCustomer extends Context.Service<
  CurrentCustomer,
  { readonly customerId: CustomerId }
>()("Bank/CurrentCustomer") {}
