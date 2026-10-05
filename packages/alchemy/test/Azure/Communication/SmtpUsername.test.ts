import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as communication from "@distilled.cloud/azure/communication";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSmtp = (
  resourceGroupName: string,
  communicationServiceName: string,
  smtpUsername: string,
) =>
  Effect.gen(function* () {
    return yield* communication.GetSmtpUsername({
      subscriptionId: yield* subscription,
      resourceGroupName,
      communicationServiceName,
      smtpUsername,
    });
  });

const program = (props: {
  name?: string;
  username: string;
  entraApplicationId: string;
}) =>
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
    const acs = yield* Azure.Communication.CommunicationService("Acs", {
      resourceGroup: group.resourceGroupName,
      linkedDomains: [domain.domainId],
    });
    const smtp = yield* Azure.Communication.SmtpUsername("Smtp", {
      resourceGroup: group.resourceGroupName,
      communicationService: acs.communicationServiceName,
      name: props.name,
      username: props.username,
      entraApplicationId: props.entraApplicationId,
    });
    return { group, acs, smtp };
  });

// Free; ~3 minutes. The Entra app is the test runner's own service
// principal (Alchemy has no Entra application resource yet).
test.provider(
  "create, update, replace, and delete an SMTP username",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const creds = yield* yield* Azure.resolveAzureCredentials;
      const appId = creds.clientId;

      const { group, acs, smtp } = yield* stack.deploy(
        program({ username: "alchemy-smtp-a", entraApplicationId: appId }),
      );
      const get = (name: string) =>
        getSmtp(group.resourceGroupName, acs.communicationServiceName, name);
      expect(smtp.username).toEqual("alchemy-smtp-a");
      expect(smtp.entraApplicationId.toLowerCase()).toEqual(
        appId.toLowerCase(),
      );
      expect(smtp.tenantId.toLowerCase()).toEqual(creds.tenantId.toLowerCase());
      const observed = yield* get(smtp.smtpUsernameName);
      expect(observed.properties?.username).toEqual("alchemy-smtp-a");

      // In-place: point the login at another Entra application.
      const otherApp = "00000003-0000-0000-c000-000000000000";
      const updated = yield* stack.deploy(
        program({ username: "alchemy-smtp-a", entraApplicationId: otherApp }),
      );
      expect(updated.smtp.smtpUsernameId).toEqual(smtp.smtpUsernameId);
      const reobserved = yield* get(smtp.smtpUsernameName);
      expect(reobserved.properties?.entraApplicationId).toEqual(otherApp);

      // Replacement: Azure does not allow changing the username.
      const replaced = yield* stack.deploy(
        program({ username: "alchemy-smtp-b", entraApplicationId: appId }),
      );
      expect(replaced.smtp.smtpUsernameName).not.toEqual(smtp.smtpUsernameName);
      expect(
        (yield* get(replaced.smtp.smtpUsernameName)).properties?.username,
      ).toEqual("alchemy-smtp-b");
      expect(yield* waitGone(get(smtp.smtpUsernameName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.smtp.smtpUsernameName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
