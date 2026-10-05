import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as automation from "@distilled.cloud/azure/automation";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  REPLACEMENT,
  SHARED,
  subscription,
  tags,
  waitGone,
  sharedAccountTest,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  replaced?: boolean;
  publicNetworkAccess?: boolean;
  disableLocalAuth?: boolean;
  identity?: boolean;
  env: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      name: SHARED.resourceGroup,
      location: SHARED.location,
    });
    const account = yield* Azure.Automation.AutomationAccount("Account", {
      resourceGroup: group.resourceGroupName,
      name: props.replaced ? REPLACEMENT.account : SHARED.account,
      location: props.replaced ? REPLACEMENT.location : SHARED.location,
      publicNetworkAccess: props.publicNetworkAccess,
      disableLocalAuth: props.disableLocalAuth,
      identity: props.identity ? { type: "SystemAssigned" } : undefined,
      tags: { env: props.env },
    });
    return { group, account };
  });

const getAccount = (resourceGroupName: string, automationAccountName: string) =>
  Effect.gen(function* () {
    return yield* automation.GetAutomationAccount({
      subscriptionId: yield* subscription,
      resourceGroupName,
      automationAccountName,
    });
  });

// Automation accounts are free; provisioning takes seconds. Names are fixed
// because the trial allows one account per region (see util.ts).
test.provider(
  "create, update, replace, and delete an automation account",
  (stack) =>
    sharedAccountTest(stack)(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { group, account } = yield* stack.deploy(program({ env: "a" }));
        const rg = group.resourceGroupName;
        expect(account.sku).toEqual("Basic");
        const observed = yield* getAccount(rg, account.automationAccountName);
        expect(observed.tags?.env).toEqual("a");
        expect(observed.tags?.["alchemy::id"]).toEqual("Account");

        // In-place: network/auth flags, identity, tags.
        const updated = yield* stack.deploy(
          program({
            env: "b",
            publicNetworkAccess: false,
            disableLocalAuth: true,
            identity: true,
          }),
        );
        expect(updated.account.automationAccountId).toEqual(
          account.automationAccountId,
        );
        expect(updated.account.principalId).toBeTruthy();
        const reobserved = yield* getAccount(rg, account.automationAccountName);
        expect(reobserved.tags?.env).toEqual("b");
        expect(reobserved.properties?.publicNetworkAccess).toEqual(false);
        expect(reobserved.properties?.disableLocalAuth).toEqual(true);
        expect(reobserved.identity?.type).toEqual("SystemAssigned");

        // Replacement: name and location are immutable.
        const replaced = yield* stack.deploy(
          program({ replaced: true, env: "b" }),
        );
        expect(replaced.account.automationAccountName).toEqual(
          REPLACEMENT.account,
        );
        expect(replaced.account.location.toLowerCase()).toEqual(
          REPLACEMENT.location,
        );
        expect(
          yield* waitGone(getAccount(rg, account.automationAccountName)),
        ).toEqual("gone");

        yield* stack.destroy();
        expect(
          yield* waitGone(
            getAccount(rg, replaced.account.automationAccountName),
          ),
        ).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);
