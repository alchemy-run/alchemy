import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as communication from "@distilled.cloud/azure/communication";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getList = (
  resourceGroupName: string,
  emailServiceName: string,
  domainName: string,
  suppressionListName: string,
) =>
  Effect.gen(function* () {
    return yield* communication.GetSuppressionList({
      subscriptionId: yield* subscription,
      resourceGroupName,
      emailServiceName,
      domainName,
      suppressionListName,
    });
  });

const program = (props: { name?: string; listName: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const email = yield* Azure.Communication.EmailService("Email", {
      resourceGroup: group.resourceGroupName,
    });
    const domain = yield* Azure.Communication.EmailDomain("Domain", {
      resourceGroup: group.resourceGroupName,
      emailService: email.emailServiceName,
    });
    const sender = yield* Azure.Communication.SenderUsername("Alerts", {
      resourceGroup: group.resourceGroupName,
      emailService: email.emailServiceName,
      domain: domain.domainName,
      username: "alerts",
    });
    const list = yield* Azure.Communication.SuppressionList("List", {
      resourceGroup: group.resourceGroupName,
      emailService: email.emailServiceName,
      domain: domain.domainName,
      name: props.name,
      // The list must name an existing sender of the domain.
      listName: props.listName === "alerts" ? sender.username : props.listName,
    });
    return { group, email, domain, list };
  });

// Free; ~2-3 minutes (email service + Azure-managed domain).
test.provider(
  "create, update, replace, and delete a suppression list",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, email, domain, list } = yield* stack.deploy(
        program({ listName: "DoNotReply" }),
      );
      const get = (name: string) =>
        getList(
          group.resourceGroupName,
          email.emailServiceName,
          domain.domainName,
          name,
        );
      // Azure stores the list name lowercased.
      expect(list.listName?.toLowerCase()).toEqual("donotreply");
      const observed = yield* get(list.suppressionListName);
      expect(observed.properties?.listName?.toLowerCase()).toEqual(
        "donotreply",
      );

      // In-place: switch the list to the `alerts` sender.
      const updated = yield* stack.deploy(program({ listName: "alerts" }));
      expect(updated.list.suppressionListId).toEqual(list.suppressionListId);
      const reobserved = yield* get(list.suppressionListName);
      expect(reobserved.properties?.listName?.toLowerCase()).toEqual("alerts");

      // Replacement: the resource name.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-suppression-2", listName: "DoNotReply" }),
      );
      expect(replaced.list.suppressionListName).toEqual(
        "alchemy-suppression-2",
      );
      expect(
        (yield* get(
          "alchemy-suppression-2",
        )).properties?.listName?.toLowerCase(),
      ).toEqual("donotreply");
      expect(yield* waitGone(get(list.suppressionListName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-suppression-2"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
