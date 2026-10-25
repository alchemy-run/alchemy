import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as Schema from "effect/Schema";

const AccountId = Schema.String.pipe(Schema.brand("AccountId"));
const CustomerId = Schema.String.pipe(Schema.brand("CustomerId"));

class Opened extends Domain.Event("Opened") {}
class OpenAccount extends Domain.Command("OpenAccount", { target: AccountId, events: [Opened] }) {}
// Addresses a customer, so it does not belong on Account.
class OpenForCustomer extends Domain.Command("OpenForCustomer", {
  target: CustomerId,
  events: [Opened],
}) {}
// A plain string target accepts ids that are not an AccountId.
class OpenAny extends Domain.Command("OpenAny", { target: Schema.String, events: [Opened] }) {}

describe("Domain command target", () => {
  it("a command addresses its aggregate's id", () => {
    class Account extends Domain.Aggregate("Account", {
      id: AccountId,
      state: Schema.Struct({}),
      initial: {},
      commands: [OpenAccount],
      decide: { OpenAccount: () => [new Opened()] },
      evolve: { Opened: (s) => s },
    }) {}
    expect(Account.ref("a-1").id).toBe("a-1");
  });

  it("a command whose target is another id schema is a type error", () => {
    // @ts-expect-error OpenForCustomer targets a CustomerId, not an AccountId
    class Account extends Domain.Aggregate("Account", {
      id: AccountId,
      state: Schema.Struct({}),
      initial: {},
      commands: [OpenAccount, OpenForCustomer],
      decide: { OpenAccount: () => [new Opened()], OpenForCustomer: () => [new Opened()] },
      evolve: { Opened: (s) => s },
    }) {}
    expect(Account.aggregateName).toBe("Account");
  });

  it("a command whose target is wider than the id is a type error", () => {
    // @ts-expect-error OpenAny targets any string, not an AccountId
    class Account extends Domain.Aggregate("Account", {
      id: AccountId,
      state: Schema.Struct({}),
      initial: {},
      commands: [OpenAny],
      decide: { OpenAny: () => [new Opened()] },
      evolve: { Opened: (s) => s },
    }) {}
    expect(Account.aggregateName).toBe("Account");
  });
});
