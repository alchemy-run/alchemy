import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as communication from "@distilled.cloud/azure/communication";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSender = (
  resourceGroupName: string,
  emailServiceName: string,
  domainName: string,
  senderUsername: string,
) =>
  Effect.gen(function* () {
    return yield* communication.GetSenderUsername({
      subscriptionId: yield* subscription,
      resourceGroupName,
      emailServiceName,
      domainName,
      senderUsername,
    });
  });

const program = (props: { username: string; displayName: string }) =>
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
    const sender = yield* Azure.Communication.SenderUsername("Sender", {
      resourceGroup: group.resourceGroupName,
      emailService: email.emailServiceName,
      domain: domain.domainName,
      username: props.username,
      displayName: props.displayName,
    });
    return { group, email, domain, sender };
  });

// Free; ~2-3 minutes (email service + Azure-managed domain).
test.provider(
  "create, update, replace, and delete a sender username",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, email, domain, sender } = yield* stack.deploy(
        program({ username: "DoNotReply", displayName: "Alchemy Test" }),
      );
      const get = (username: string) =>
        getSender(
          group.resourceGroupName,
          email.emailServiceName,
          domain.domainName,
          username,
        );
      expect(sender.username).toEqual("DoNotReply");
      expect(sender.displayName).toEqual("Alchemy Test");
      const observed = yield* get("DoNotReply");
      expect(observed.properties?.displayName).toEqual("Alchemy Test");

      // In-place: display name.
      const updated = yield* stack.deploy(
        program({ username: "DoNotReply", displayName: "Alchemy Prod" }),
      );
      expect(updated.sender.senderUsernameId).toEqual(sender.senderUsernameId);
      const reobserved = yield* get("DoNotReply");
      expect(reobserved.properties?.displayName).toEqual("Alchemy Prod");

      // Replacement: the username is the resource name.
      const replaced = yield* stack.deploy(
        program({ username: "alerts", displayName: "Alchemy Alerts" }),
      );
      expect(replaced.sender.username).toEqual("alerts");
      const replacedObserved = yield* get("alerts");
      expect(replacedObserved.properties?.displayName).toEqual(
        "Alchemy Alerts",
      );
      expect(yield* waitGone(get("DoNotReply"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alerts"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
