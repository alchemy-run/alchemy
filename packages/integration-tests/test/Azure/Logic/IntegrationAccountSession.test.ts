import * as Azure from "@alchemy.run/azure";
import * as logic from "@distilled.cloud/azure/logic";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { freeAccount, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { name?: string; content: Record<string, unknown> }) =>
  Effect.gen(function* () {
    // One Free account per region per subscription: this file owns canadacentral.
    const { group, account } = yield* freeAccount("canadacentral");
    const session = yield* Azure.Logic.IntegrationAccountSession("Orders", {
      resourceGroup: group.resourceGroupName,
      integrationAccount: account.integrationAccountName,
      name: props.name,
      content: props.content,
    });
    return { group, account, session };
  });

const getSession = (rg: string, account: string, sessionName: string) =>
  Effect.gen(function* () {
    return yield* logic.GetIntegrationAccountSession({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      integrationAccountName: account,
      sessionName,
    });
  });

// Free integration account: no cost, synchronous.
test.provider(
  "create, update, replace, and delete an integration account session",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = { controlNumber: "1000", partner: { name: "fabrikam" } };
      const { group, account, session } = yield* stack.deploy(program({ content: first }));
      const rg = group.resourceGroupName;
      const ia = account.integrationAccountName;
      expect(session.content).toEqual(first);
      const observed = yield* getSession(rg, ia, session.sessionName);
      expect(observed.properties.content).toEqual(first);

      // In-place: a key removed and a value changed.
      const second = { controlNumber: "2000" };
      const updated = yield* stack.deploy(program({ content: second }));
      expect(updated.session.sessionId).toEqual(session.sessionId);
      expect(updated.session.content).toEqual(second);
      const reobserved = yield* getSession(rg, ia, session.sessionName);
      expect(reobserved.properties.content).toEqual(second);

      // Replacement: a new name.
      const replaced = yield* stack.deploy(program({ name: "orders-v2", content: second }));
      expect(replaced.session.sessionName).toEqual("orders-v2");
      expect(yield* waitGone(getSession(rg, ia, session.sessionName))).toEqual("gone");
      const replacedObserved = yield* getSession(rg, ia, "orders-v2");
      expect(replacedObserved.properties.content).toEqual(second);

      yield* stack.destroy();
      expect(yield* waitGone(getSession(rg, ia, "orders-v2"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
