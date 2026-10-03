import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as communication from "@distilled.cloud/azure/communication";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getService = (
  resourceGroupName: string,
  communicationServiceName: string,
) =>
  Effect.gen(function* () {
    return yield* communication.GetCommunicationService({
      subscriptionId: yield* subscription,
      resourceGroupName,
      communicationServiceName,
    });
  });

const program = (props: {
  dataLocation?: string;
  link: boolean;
  disableLocalAuth?: boolean;
  tags: Record<string, string>;
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
    const service = yield* Azure.Communication.CommunicationService("Acs", {
      resourceGroup: group.resourceGroupName,
      dataLocation: props.dataLocation,
      linkedDomains: props.link ? [domain.domainId] : [],
      disableLocalAuth: props.disableLocalAuth,
      tags: props.tags,
    });
    return { group, domain, service };
  });

// Communication services are free (billed per message); ~1-2 minutes.
test.provider(
  "create, update, replace, and delete a communication service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, domain, service } = yield* stack.deploy(
        program({ link: false, tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      expect(service.dataLocation).toEqual("United States");
      expect(service.hostName).toContain("communication.azure.com");
      expect(service.disableLocalAuth).toEqual(false);
      expect(service.primaryConnectionString).toBeDefined();
      expect(
        Redacted.value(service.primaryConnectionString!).toLowerCase(),
      ).toContain("endpoint=https://");
      const observed = yield* getService(rg, service.communicationServiceName);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.properties?.linkedDomains ?? []).toEqual([]);

      // In-place: link the domain, disable keys, change tags.
      const updated = yield* stack.deploy(
        program({
          link: true,
          disableLocalAuth: true,
          tags: { env: "prod" },
        }),
      );
      expect(updated.service.communicationServiceId).toEqual(
        service.communicationServiceId,
      );
      expect(updated.service.primaryKey).toBeUndefined();
      const reobserved = yield* getService(
        rg,
        service.communicationServiceName,
      );
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.properties?.disableLocalAuth).toEqual(true);
      expect(
        (reobserved.properties?.linkedDomains ?? []).map((d) =>
          d.toLowerCase(),
        ),
      ).toEqual([domain.domainId.toLowerCase()]);

      // Replacement: the data location is immutable.
      const replaced = yield* stack.deploy(
        program({ dataLocation: "Europe", link: false, tags: { env: "prod" } }),
      );
      expect(replaced.service.communicationServiceName).not.toEqual(
        service.communicationServiceName,
      );
      const replacedObserved = yield* getService(
        rg,
        replaced.service.communicationServiceName,
      );
      expect(replacedObserved.properties?.dataLocation).toEqual("Europe");
      expect(
        yield* waitGone(getService(rg, service.communicationServiceName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getService(rg, replaced.service.communicationServiceName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
