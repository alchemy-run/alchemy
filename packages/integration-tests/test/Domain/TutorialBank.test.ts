import { describe, expect, it } from "@alchemy.run/test";
// Part 6 of the Domain tutorial: the Effect UI app's Story and Scene tests,
// over the tutorial's bank Api.
import { HtmlLocator, HtmlScene } from "@effect/ui/html/testing";
import { Story } from "@effect/ui/testing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { NotOpen } from "./tutorial-bank/Bank.model.ts";
import { CustomerId } from "./tutorial-bank/Customer.id.ts";
import { BankMessage, BankNoDeps, BankUI } from "./tutorial-bank/web/Bank.ts";

const props = { customerId: CustomerId.make("c-2") };
const summary = (owner: string | null, balance: number) => ({
  state: Option.some({ owner, balance }),
  cursor: 1,
});

describe("Domain tutorial: the bank app", { tags: ["unit"] }, () => {
  it.effect("opens the customer's account", () =>
    Effect.gen(function* () {
      const s = yield* Story.make(BankNoDeps, props);
      s.loaded("summary", { state: Option.none(), cursor: 0 })
        .send(BankMessage.ClickedOpen())
        .expectExact(BankUI.RegisterCustomer);
      expect(s.pending[0]!.command.args).toMatchObject({
        input: { customerId: "c-2", name: "c-2" },
      });
      s.resolve(BankUI.RegisterCustomer, {
        commandId: "page:0",
        reply: undefined,
        receipt: { stream: "Customer/c-2", version: 1 },
        commits: [{ stream: "Customer/c-2", version: 1 }],
      });
      expect(s.model.error).toBeNull();
    }),
  );

  it.effect("deposits, and shows the balance the view reports", () =>
    Effect.gen(function* () {
      const s = yield* HtmlScene.make(BankNoDeps, props);
      s.loaded("summary", summary("c-2", 0))
        .expect(HtmlLocator.label("Balance"))
        .toHaveText("Balance: 0.00")
        .click(HtmlLocator.role("button", { name: "Deposit 10.00" }))
        .resolve(BankUI.DepositMoney, {
          commandId: "page:0",
          reply: { balance: 1_000 },
          receipt: { stream: "Account/c-2-main", version: 2 },
          commits: [{ stream: "Account/c-2-main", version: 2 }],
        })
        // The balance comes from the view, not from the command's reply.
        .expect(HtmlLocator.label("Balance"))
        .toHaveText("Balance: 0.00")
        .loaded("summary", summary("c-2", 1_000))
        .expect(HtmlLocator.label("Balance"))
        .toHaveText("Balance: 10.00");
    }),
  );

  it.effect("shows why a deposit was refused", () =>
    Effect.gen(function* () {
      const s = yield* HtmlScene.make(BankNoDeps, props);
      s.loaded("summary", summary("c-2", 0))
        .click(HtmlLocator.role("button", { name: "Deposit 10.00" }))
        .fail(BankUI.DepositMoney, {
          _tag: "Rejected",
          commandId: "page:0",
          rejection: new NotOpen(),
        })
        .expect(HtmlLocator.role("alert"))
        .toHaveText("Rejected");
    }),
  );
});
