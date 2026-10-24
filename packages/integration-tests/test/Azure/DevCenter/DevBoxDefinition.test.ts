import * as Azure from "@alchemy.run/azure";
import * as devcenter from "@distilled.cloud/azure/devcenter";
import { expect } from "alchemy-test";
import * as Output from "alchemy/Output";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDefinition = (
  resourceGroupName: string,
  devCenterName: string,
  devBoxDefinitionName: string,
) =>
  Effect.gen(function* () {
    return yield* devcenter.GetDevBoxDefinition({
      subscriptionId: yield* subscription,
      resourceGroupName,
      devCenterName,
      devBoxDefinitionName,
    });
  });

const center = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const center = yield* Azure.DevCenter.DevCenter("Center", {
    resourceGroup: group.resourceGroupName,
    location: "eastus",
  });
  return { group, center };
});

const program = (props: {
  name?: string;
  hibernateSupport: "Enabled" | "Disabled";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, center: parent } = yield* center;
    const definition = yield* Azure.DevCenter.DevBoxDefinition("Definition", {
      resourceGroup: group.resourceGroupName,
      devCenter: parent.devCenterName,
      name: props.name,
      location: "eastus",
      imageReferenceId: Output.interpolate`${parent.devCenterId}/galleries/default/images/microsoftwindowsdesktop_windows-ent-cpc_win11-24h2-ent-cpc`,
      skuName: "general_i_8c32gb256ssd_v2",
      osStorageType: "ssd_256gb",
      hibernateSupport: props.hibernateSupport,
      tags: props.tags,
    });
    return { group, center: parent, definition };
  });

// Ungated: the trial tenant was never onboarded to Dev Box, which stopped
// accepting new customers on 2025-11-01, so a definition is rejected with
// a typed error. ~7 minutes (dev center create + delete), $0.
test.provider(
  "dev box definitions are rejected for tenants not onboarded to Dev Box",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group, center: parent } = yield* stack.deploy(center);
      const error = yield* devcenter
        .DevBoxDefinitionsCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          devCenterName: parent.devCenterName,
          devBoxDefinitionName: "alchemy-probe",
          location: "eastus",
          properties: {
            imageReference: {
              id: `${parent.devCenterId}/galleries/default/images/microsoftwindowsdesktop_windows-ent-cpc_win11-24h2-ent-cpc`,
            },
            sku: { name: "general_i_8c32gb256ssd_v2" },
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("DevBoxTenantNotOnboarded");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Gated: needs a tenant onboarded to Dev Box (see the probe above).
// ~$0/run, 10 min: dev centers and definitions are free (no dev boxes are
// created); the dev center create and delete dominate.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a dev box definition",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const {
        group,
        center: parent,
        definition,
      } = yield* stack.deploy(program({ hibernateSupport: "Disabled", tags: { a: "1" } }));
      expect(definition.skuName).toEqual("general_i_8c32gb256ssd_v2");
      const observed = yield* getDefinition(
        group.resourceGroupName,
        parent.devCenterName,
        definition.devBoxDefinitionName,
      );
      expect(observed.id).toEqual(definition.devBoxDefinitionId);
      expect(observed.properties?.sku?.name).toEqual("general_i_8c32gb256ssd_v2");
      expect(observed.properties?.osStorageType).toEqual("ssd_256gb");
      expect(observed.properties?.hibernateSupport).toEqual("Disabled");
      expect(observed.tags?.a).toEqual("1");
      expect(observed.tags?.["alchemy::id"]).toEqual("Definition");

      // In place: hibernation support and tags.
      const updated = yield* stack.deploy(
        program({ hibernateSupport: "Enabled", tags: { a: "2" } }),
      );
      expect(updated.definition.devBoxDefinitionId).toEqual(definition.devBoxDefinitionId);
      const reobserved = yield* getDefinition(
        group.resourceGroupName,
        parent.devCenterName,
        definition.devBoxDefinitionName,
      );
      expect(reobserved.properties?.hibernateSupport).toEqual("Enabled");
      expect(reobserved.tags?.a).toEqual("2");

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-definition-renamed",
          hibernateSupport: "Enabled",
          tags: { a: "2" },
        }),
      );
      expect(replaced.definition.devBoxDefinitionName).toEqual("alchemy-definition-renamed");
      expect(
        yield* waitGone(
          getDefinition(
            group.resourceGroupName,
            parent.devCenterName,
            definition.devBoxDefinitionName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getDefinition(group.resourceGroupName, parent.devCenterName, "alchemy-definition-renamed"),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);
