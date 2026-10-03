import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as domainservices from "@distilled.cloud/azure/domainservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runExpensive } from "../gates.ts";
import { logLevel, network, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getOuContainer = (
  resourceGroupName: string,
  domainServiceName: string,
  ouContainerName: string,
) =>
  Effect.gen(function* () {
    return yield* domainservices.GetOuContainer({
      subscriptionId: yield* subscription,
      resourceGroupName,
      domainServiceName,
      ouContainerName,
    });
  });

const program = (props: { spn: string; password: string }) =>
  Effect.gen(function* () {
    const { group, subnet } = yield* network;
    const domain = yield* Azure.DomainServices.DomainService("Domain", {
      resourceGroup: group.resourceGroupName,
      domainName: "aadds-alchemy-ou-test.com",
      replicaSets: [{ subnetId: subnet.subnetId }],
    });
    const ou = yield* Azure.DomainServices.OuContainer("Apps", {
      resourceGroup: group.resourceGroupName,
      domainService: domain.domainServiceName,
      accountName: "svc-alchemy",
      spn: props.spn,
      password: Redacted.make(props.password),
    });
    return { group, domain, ou };
  });

// Needs a Standard managed domain: ~$0.15/hour, 45-60 minutes to provision
// and ~30 to delete (~$0.30 per run, far over the time budget). One managed
// domain per tenant, so it cannot run alongside the DomainService test.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete an OU container",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, domain, ou } = yield* stack.deploy(
        program({ spn: "http/apps1.alchemy", password: "Alchemy-Test-Pw-1!" }),
      );
      const get = () =>
        getOuContainer(
          group.resourceGroupName,
          domain.domainServiceName,
          ou.ouContainerName,
        );
      const observed = yield* get();
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.accounts?.[0]?.accountName).toEqual(
        "svc-alchemy",
      );
      expect(ou.distinguishedName).toContain(ou.ouContainerName);

      // In-place: new SPN and password.
      const updated = yield* stack.deploy(
        program({ spn: "http/apps2.alchemy", password: "Alchemy-Test-Pw-2!" }),
      );
      expect(updated.ou.ouContainerId).toEqual(ou.ouContainerId);
      const reobserved = yield* get();
      expect(reobserved.properties?.accounts?.[0]?.spn).toEqual(
        "http/apps2.alchemy",
      );

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  // Parent create (~60 min) + delete (~30 min) exceed the usual 15-minute cap.
  { tags, timeout: 7_200_000 },
);
