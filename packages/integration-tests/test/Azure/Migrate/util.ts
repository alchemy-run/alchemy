import * as Azure from "@alchemy.run/azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:migrate", "live"];

/** Azure Migrate serves a fixed set of geographies; eastus is not one. */
export const location = "centralus";

export const subscription = Effect.map(Azure.AzureEnvironment.current, (env) => env.subscriptionId);

/**
 * Placeholder Microsoft Entra application for collector agents. Azure
 * stores it without validating it; no appliance ever signs in with it.
 */
export const servicePrincipal = {
  tenantId: "00000000-0000-0000-0000-00000000a1c1",
  applicationId: "00000000-0000-0000-0000-00000000a1c2",
  objectId: "00000000-0000-0000-0000-00000000a1c3",
  audience: "00000000-0000-0000-0000-00000000a1c2",
  authority: "https://login.windows.net/00000000-0000-0000-0000-00000000a1c1",
};

/** {@link servicePrincipal} with a different application, for in-place updates. */
export const rotatedServicePrincipal = {
  ...servicePrincipal,
  applicationId: "00000000-0000-0000-0000-00000000a1c4",
  audience: "00000000-0000-0000-0000-00000000a1c4",
};

/**
 * An assessment group that already holds discovered machines, for the
 * assessment lifecycles: assessments need machines an on-premises appliance
 * (or a CSV import) reported. Set `AZURE_TEST_MIGRATE_GROUP_ID` to the
 * group's ARM ID, e.g.
 * `/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Migrate/assessmentProjects/<project>/groups/<group>`.
 */
export const discoveredGroup = (() => {
  const id = process.env.AZURE_TEST_MIGRATE_GROUP_ID;
  const match = id?.match(
    /\/resourceGroups\/([^/]+)\/.*\/assessmentProjects\/([^/]+)\/groups\/([^/]+)$/i,
  );
  return id === undefined || match === null || match === undefined
    ? undefined
    : { id, resourceGroup: match[1]!, assessmentProject: match[2]!, group: match[3]! };
})();

/**
 * A run-as account a live appliance registered on its discovery site, for
 * the vCenter, Hyper-V host, and Hyper-V cluster lifecycles. `idVar` names
 * the variable holding the account's ARM ID
 * (`.../resourceGroups/<rg>/providers/Microsoft.OffAzure/<kind>Sites/<site>/runAsAccounts/<id>`);
 * `fqdnVar` names the variable holding a machine the appliance reaches with
 * it.
 */
export const applianceRunAs = (idVar: string, fqdnVar: string) => {
  const id = process.env[idVar];
  const fqdn = process.env[fqdnVar];
  const match = id?.match(/\/resourceGroups\/([^/]+)\/.*\/\w+Sites\/([^/]+)\/runAsAccounts\//i);
  return id === undefined || fqdn === undefined || match === null || match === undefined
    ? undefined
    : { runAsAccountId: id, fqdn, resourceGroup: match[1]!, site: match[2]! };
};

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound", "MigrateVcenterNotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );
