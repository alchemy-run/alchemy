import * as Azure from "@alchemy.run/azure";
import * as migrate from "@distilled.cloud/azure/migrate";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { applianceRunAs, location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getHost = (resourceGroupName: string, siteName: string, hostName: string) =>
  Effect.gen(function* () {
    return yield* migrate.GetHypervHostController({
      subscriptionId: yield* subscription,
      resourceGroupName,
      siteName,
      hostName,
    });
  });

const appliance = applianceRunAs(
  "AZURE_TEST_MIGRATE_HYPERV_RUN_AS_ACCOUNT_ID",
  "AZURE_TEST_MIGRATE_HYPERV_HOST_FQDN",
);

// Free control-plane object; a few minutes. A Hyper-V host entry needs a
// run-as account that a live Azure Migrate appliance registered on its
// Hyper-V site, and a host the appliance reaches: needs-external-systems, so
// the lifecycle only runs with AZURE_TEST_PAID=1,
// AZURE_TEST_MIGRATE_HYPERV_RUN_AS_ACCOUNT_ID, and
// AZURE_TEST_MIGRATE_HYPERV_HOST_FQDN.
test.provider.skipIf(!runPaidOnly || appliance === undefined)(
  "create, redeploy, replace, and delete a Hyper-V host",
  (stack) =>
    Effect.gen(function* () {
      const target = appliance!;
      const program = (name: string) =>
        Azure.Migrate.HypervHost("Host", {
          resourceGroup: target.resourceGroup,
          hypervSite: target.site,
          name,
          fqdn: target.fqdn,
          runAsAccountId: target.runAsAccountId,
        });
      const get = (name: string) => getHost(target.resourceGroup, target.site, name);
      yield* stack.destroy();

      const host = yield* stack.deploy(program("alchemy-host-a"));
      expect(host.fqdn).toEqual(target.fqdn);
      const observed = yield* get("alchemy-host-a");
      expect(observed.properties?.fqdn).toEqual(target.fqdn);

      // Redeploying the same props keeps the host.
      const same = yield* stack.deploy(program("alchemy-host-a"));
      expect(same.hostId).toEqual(host.hostId);

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(program("alchemy-host-b"));
      expect(replaced.hostName).toEqual("alchemy-host-b");
      expect(yield* waitGone(get("alchemy-host-a"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-host-b"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, under a minute), skipped after three iterations.
// Skipped: on a site without a live appliance Azure answers the PUT with a
// bare HTTP 400 `BadRequest` "Object reference not set to an instance of an
// object." (no error code) for any fully qualified run-as account ID, so
// there is no specific error to type; the rejected PUT also leaves the entry
// in a non-terminal provisioning state until the site is deleted.
test.provider.skip(
  "a Hyper-V host without a registered run-as account is rejected with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, site } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", { location });
          const site = yield* Azure.Migrate.HypervSite("Site", {
            resourceGroup: group.resourceGroupName,
            location,
          });
          return { group, site };
        }),
      );
      const error = yield* migrate
        .CreateHypervHostController({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          siteName: site.siteName,
          hostName: "probe",
          properties: {
            fqdn: "hyperv01.contoso.local",
            runAsAccountId: `${site.siteId}/runasaccounts/probe`,
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("MigrateRunAsAccountInvalid");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
