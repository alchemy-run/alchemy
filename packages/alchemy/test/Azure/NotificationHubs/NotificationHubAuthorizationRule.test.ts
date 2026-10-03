import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as notificationhubs from "@distilled.cloud/azure/notificationhubs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  getNamespace,
  gone,
  logLevel,
  namespaceProgram,
  subscriptionId,
  tags,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRule = (
  resourceGroupName: string,
  namespaceName: string,
  notificationHubName: string,
  authorizationRuleName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    notificationhubs.GetNotificationHubAuthorizationRule({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      notificationHubName,
      authorizationRuleName,
    }),
  );

const program = (props: {
  name?: string;
  rights: Azure.NotificationHubs.NotificationHubsAccessRight[];
}) =>
  Effect.gen(function* () {
    const { group, ns } = yield* namespaceProgram;
    const hub = yield* Azure.NotificationHubs.NotificationHub("Hub", {
      resourceGroup: group.resourceGroupName,
      namespace: ns.namespaceName,
    });
    const rule = yield* Azure.NotificationHubs.NotificationHubAuthorizationRule(
      "Rule",
      {
        resourceGroup: group.resourceGroupName,
        namespace: ns.namespaceName,
        notificationHub: hub.notificationHubName,
        name: props.name,
        rights: props.rights,
      },
    );
    return { group, ns, hub, rule };
  });

// Free namespace + hub + SAS rule: $0; a few minutes.
test.provider(
  "create, update, replace, and delete a notification hub authorization rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, ns, hub, rule } = yield* stack.deploy(
        program({ rights: ["Listen"] }),
      );
      const rg = group.resourceGroupName;
      const hubName = hub.notificationHubName;
      expect(rule.rights).toEqual(["Listen"]);
      expect(rule.primaryConnectionString).toBeDefined();
      expect(Redacted.value(rule.primaryConnectionString!)).toContain(
        `SharedAccessKeyName=${rule.authorizationRuleName}`,
      );
      const observed = yield* getRule(
        rg,
        ns.namespaceName,
        hubName,
        rule.authorizationRuleName,
      );
      expect(observed.properties?.rights).toEqual(["Listen"]);

      // In place: rights.
      const updated = yield* stack.deploy(program({ rights: ["Send"] }));
      expect(updated.rule.authorizationRuleName).toEqual(
        rule.authorizationRuleName,
      );
      expect(updated.rule.rights).toEqual(["Send"]);
      const reobserved = yield* getRule(
        rg,
        ns.namespaceName,
        hubName,
        rule.authorizationRuleName,
      );
      expect(reobserved.properties?.rights).toEqual(["Send"]);

      // Replacement: explicit name.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-renamed-hub-rule", rights: ["Send"] }),
      );
      expect(replaced.rule.authorizationRuleName).toEqual(
        "alchemy-renamed-hub-rule",
      );
      expect(
        yield* gone(
          getRule(rg, ns.namespaceName, hubName, rule.authorizationRuleName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(yield* gone(getNamespace(rg, ns.namespaceName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
