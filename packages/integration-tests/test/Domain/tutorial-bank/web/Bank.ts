import * as DomainEffectUI from "@alchemy.run/domain/EffectUI";
import { Command, Component, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Schema from "effect/Schema";
import { AccountId } from "../Account.id.ts";
import { BankApi } from "../BankApi.api.ts";
import { CustomerId } from "../Customer.id.ts";

// The bank's commands and its view, as Effect UI services.
export const BankUI = DomainEffectUI.make(BankApi);

export const BankMessage = UiSchema.TaggedEnum({
  ClickedOpen: {},
  ClickedDeposit: {},
  Succeeded: {},
  Failed: { reason: Schema.String },
});

const accountIdOf = (customerId: typeof CustomerId.Type) => AccountId.make(`${customerId}-main`);

export const BankNoDeps = Html.component({
  name: "Bank",
  props: Schema.Struct({ customerId: CustomerId }),
  model: Schema.Struct({ error: Schema.NullOr(Schema.String) }),
  message: BankMessage,
  queries: {
    summary: {
      query: BankUI.AccountSummary,
      args: ({ props }) => ({ key: accountIdOf(props.customerId) }),
    },
  },
}).make({
  init: () => ({ error: null }),
  update: {
    ClickedOpen: ($) =>
      $.run(
        BankUI.RegisterCustomer.make({
          input: { customerId: $.props.customerId, name: $.props.customerId },
        }).pipe(
          Command.match({
            onSuccess: () => BankMessage.Succeeded(),
            onFailure: (failure) => BankMessage.Failed({ reason: failure._tag }),
          }),
        ),
      ),
    ClickedDeposit: ($) =>
      $.run(
        BankUI.DepositMoney.make({
          input: { accountId: accountIdOf($.props.customerId), amount: 1_000 },
        }).pipe(
          Command.match({
            onSuccess: () => BankMessage.Succeeded(),
            onFailure: (failure) => BankMessage.Failed({ reason: failure._tag }),
          }),
        ),
      ),
    // The balance arrives through the view; success only clears an error.
    Succeeded: ($) => $.evolve({ error: null }),
    Failed: ($, { reason }) => $.evolve({ error: reason }),
  },
  view: (h, model) => {
    const summary = Option.flatMap(AsyncResult.value(h.queries.summary), ({ state }) => state);
    const balance = Option.flatMap(summary, ({ owner, balance }) =>
      owner === null ? Option.none() : Option.some(balance),
    );
    return h.div(
      h.p(`Signed in as ${h.props.customerId}`),
      Option.match(balance, {
        onNone: () => h.button.on("click", BankMessage.ClickedOpen()).children("Open my account"),
        onSome: (balance) =>
          h.div(
            h.p.attr("aria-label", "Balance").children(`Balance: ${(balance / 100).toFixed(2)}`),
            h.button.on("click", BankMessage.ClickedDeposit()).children("Deposit 10.00"),
          ),
      }),
      model.error !== null && h.p.attr("role", "alert").children(model.error),
    );
  },
});

// The app with its commands and view provided; the entry provides the bank's client.
export const Bank = BankNoDeps.pipe(Component.provide(BankUI.layer));
