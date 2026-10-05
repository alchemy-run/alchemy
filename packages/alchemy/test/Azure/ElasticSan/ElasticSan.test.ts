import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as elasticsan from "@distilled.cloud/azure/elasticsan";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSan = (resourceGroupName: string, elasticSanName: string) =>
  Effect.gen(function* () {
    return yield* elasticsan.GetElasticSan({
      subscriptionId: yield* subscription,
      resourceGroupName,
      elasticSanName,
    });
  });

const program = (props: {
  name?: string;
  extendedCapacitySizeTiB?: number;
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const san = yield* Azure.ElasticSan.ElasticSan("San", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      extendedCapacitySizeTiB: props.extendedCapacitySizeTiB,
      tags: props.tags,
    });
    return { group, san };
  });

// Minimum 1 TiB base capacity (~$0.13/hour): ~$0.05 per run, ~5 minutes.
test.provider(
  "create, update, replace, and delete an elastic san",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ tags: { env: "test" } }));
      const rg = created.group.resourceGroupName;
      const first = created.san;
      expect(first.elasticSanName).toMatch(
        /^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$/,
      );
      expect(first.sku).toEqual("Premium_LRS");
      expect(first.baseSizeTiB).toEqual(1);
      expect(first.extendedCapacitySizeTiB).toEqual(0);
      expect(first.tags).toEqual({ env: "test" });
      const observed = yield* getSan(rg, first.elasticSanName);
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.["alchemy::id"]).toEqual("San");

      // In-place update: extended capacity and tags.
      const updated = yield* stack.deploy(
        program({ extendedCapacitySizeTiB: 1, tags: { env: "prod" } }),
      );
      expect(updated.san.elasticSanName).toEqual(first.elasticSanName);
      expect(updated.san.elasticSanId).toEqual(first.elasticSanId);
      const reobserved = yield* getSan(rg, first.elasticSanName);
      expect(reobserved.properties.extendedCapacitySizeTiB).toEqual(1);
      expect(reobserved.tags?.env).toEqual("prod");

      // Renaming replaces the SAN.
      const renamed = yield* stack.deploy(
        program({ name: "alchemy-esan-renamed", extendedCapacitySizeTiB: 1 }),
      );
      expect(renamed.san.elasticSanName).toEqual("alchemy-esan-renamed");
      const replacement = yield* getSan(rg, "alchemy-esan-renamed");
      expect(replacement.tags?.["alchemy::id"]).toEqual("San");
      expect(yield* waitGone(getSan(rg, first.elasticSanName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(getSan(rg, "alchemy-esan-renamed"))).toEqual(
        "gone",
      );
    }),
  { tags, timeout: 900_000 },
);
