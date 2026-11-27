import { Address } from "@bank/domain/Customer/Address";
import type { CustomerId } from "@bank/domain/Customer/Customer.id";
import { CustomerApi } from "@bank/domain/CustomerApi.api";
import * as Effect from "effect/Effect";

/** Send a customer's address to be sealed under their key, and read it back opened. */
export const setAddress = Effect.fn(function* (customerId: CustomerId, address: string) {
  const bank = yield* CustomerApi.Client;
  yield* bank.SetAddress({ customerId, address: Address.plain(customerId, address) });
  return yield* bank.CustomerAddress({ customerId });
});
