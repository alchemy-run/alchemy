import * as Azure from "@alchemy.run/azure";
import * as migrate from "@distilled.cloud/azure/migrate";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { applianceRunAs, location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getVcenter = (resourceGroupName: string, siteName: string, vcenterName: string) =>
  Effect.gen(function* () {
    return yield* migrate.GetVcenterController({
      subscriptionId: yield* subscription,
      resourceGroupName,
      siteName,
      vcenterName,
    });
  });

const appliance = applianceRunAs(
  "AZURE_TEST_MIGRATE_VMWARE_RUN_AS_ACCOUNT_ID",
  "AZURE_TEST_MIGRATE_VCENTER_FQDN",
);

// Free control-plane object; a few minutes. A vCenter entry needs a run-as
// account that a live Azure Migrate appliance registered on its VMware site,
// and a vCenter the appliance reaches: needs-external-systems, so the
// lifecycle only runs with AZURE_TEST_PAID=1,
// AZURE_TEST_MIGRATE_VMWARE_RUN_AS_ACCOUNT_ID, and
// AZURE_TEST_MIGRATE_VCENTER_FQDN.
test.provider.skipIf(!runPaidOnly || appliance === undefined)(
  "create, update, replace, and delete a vCenter",
  (stack) =>
    Effect.gen(function* () {
      const target = appliance!;
      const program = (props: { name: string; friendlyName: string }) =>
        Azure.Migrate.Vcenter("Vcenter", {
          resourceGroup: target.resourceGroup,
          vmwareSite: target.site,
          name: props.name,
          fqdn: target.fqdn,
          port: "443",
          runAsAccountId: target.runAsAccountId,
          friendlyName: props.friendlyName,
        });
      const get = (name: string) => getVcenter(target.resourceGroup, target.site, name);
      yield* stack.destroy();

      const vcenter = yield* stack.deploy(program({ name: "alchemy-vc-a", friendlyName: "one" }));
      expect(vcenter.fqdn).toEqual(target.fqdn);
      const observed = yield* get("alchemy-vc-a");
      expect(observed.properties?.friendlyName).toEqual("one");

      // In place: the friendly name.
      const updated = yield* stack.deploy(program({ name: "alchemy-vc-a", friendlyName: "two" }));
      expect(updated.vcenterId).toEqual(vcenter.vcenterId);
      const reobserved = yield* get("alchemy-vc-a");
      expect(reobserved.properties?.friendlyName).toEqual("two");

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(program({ name: "alchemy-vc-b", friendlyName: "two" }));
      expect(replaced.vcenterName).toEqual("alchemy-vc-b");
      expect(yield* waitGone(get("alchemy-vc-a"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-vc-b"))).toEqual("gone");
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
  "a vCenter without a registered run-as account is rejected with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, site } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", { location });
          const site = yield* Azure.Migrate.VmwareSite("Site", {
            resourceGroup: group.resourceGroupName,
            location,
          });
          return { group, site };
        }),
      );
      const error = yield* migrate
        .CreateVcenterController({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          siteName: site.siteName,
          vcenterName: "probe",
          properties: {
            fqdn: "vcenter.contoso.local",
            port: "443",
            runAsAccountId: `${site.siteId}/runasaccounts/probe`,
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("MigrateRunAsAccountInvalid");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
