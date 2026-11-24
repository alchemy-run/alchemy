import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import { it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import { customer } from "../src/Actor.ts";
import { Bank, BankHandlers } from "../src/Bank.model.ts";
import { CurrentActor } from "../src/CurrentActor.context.ts";
import { Address } from "../src/Customer/Address.ts";
import { ContactDetails } from "../src/Customer/ContactDetails.aggregate.ts";
import { CustomerId } from "../src/Customer/Customer.id.ts";
import { CustomerAddress } from "../src/Customer/CustomerAddress.query.ts";
import { AddressSet, NotYourAddress, SetAddress } from "../src/Customer/SetAddress.command.ts";
import { FraudCheck } from "../src/Fraud/FraudCheck.external.ts";
import { MemoryLedgerStore } from "../src/Ledger/LedgerStore.ts";
import { Payments } from "../src/Settlement/Payments.external.ts";

const story = Story.make(Bank, {
  layer: BankHandlers.pipe(Layer.provide(MemoryLedgerStore)),
  stub: [FraudCheck, Payments],
});
const sam = CustomerId.make("c-1");
const contact = ContactDetails.ref(sam);

it.effect("an address is recorded sealed, and stops opening once its key is shredded", () =>
  story(
    Story.provide(CurrentActor, customer(sam)),
    Story.when(new SetAddress({ customerId: sam, address: Address.plain(sam, "1 Main St") })),
    Story.then(
      contact,
      new AddressSet({ address: Domain.sealedInTest(Address, sam, "1 Main St") }),
    ),
    Story.query(CustomerAddress, { customerId: sam }, { address: "1 Main St" }),
    Story.shred(sam),
    // The event and the state are what they were. Only the key is gone.
    Story.state(contact, { address: Domain.sealedInTest(Address, sam, "1 Main St") }),
    Story.query(CustomerAddress, { customerId: sam }, { address: null }),
  ),
);

it.effect("an address sealed under someone else's key is refused", () =>
  story(
    Story.provide(CurrentActor, customer(sam)),
    Story.when(new SetAddress({ customerId: sam, address: Address.plain("c-2", "2 Side St") })),
    Story.rejected(new NotYourAddress()),
    Story.then(contact),
  ),
);
