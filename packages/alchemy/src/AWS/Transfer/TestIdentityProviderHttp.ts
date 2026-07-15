import * as transfer from "@distilled.cloud/aws/transfer";
import * as Layer from "effect/Layer";
import { makeTransferServerHttpBinding } from "./BindingHttp.ts";
import { TestIdentityProvider } from "./TestIdentityProvider.ts";

export const TestIdentityProviderHttp = Layer.effect(
  TestIdentityProvider,
  makeTransferServerHttpBinding({
    tag: "AWS.Transfer.TestIdentityProvider",
    operation: transfer.testIdentityProvider,
    actions: ["transfer:TestIdentityProvider"],
  }),
);
