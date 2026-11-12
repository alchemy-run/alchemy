import {
  activeReplicaRegions,
  observedRegion,
  observedReplicas,
  placementTarget,
  regionPlacementPatch,
  ServiceReplicasInvalid,
  serviceRegionPlacement,
  validateReplicas,
} from "@alchemy.run/railway/ServiceRegion";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";

describe(
  "Railway service region placement",
  { tags: ["unit", "provider:railway", "provider:railway:service", "local"] },
  () => {
    it("reads deploy.multiRegionConfig and ignores the legacy region field", () => {
      const placement = serviceRegionPlacement(
        {
          services: {
            api: {
              deploy: {
                region: "us-west2",
                multiRegionConfig: {
                  "asia-southeast1-eqsg3a": { numReplicas: 1 },
                  "europe-west4-drams3a": null,
                },
              },
            },
          },
        },
        "api",
      );

      expect(activeReplicaRegions(placement)).toEqual([
        { region: "asia-southeast1-eqsg3a", replicas: 1 },
      ]);
      expect(observedRegion(placement, null)).toEqual("asia-southeast1-eqsg3a");
    });

    it("moves the workspace default onto the requested region", () => {
      const placement = {
        "asia-southeast1-eqsg3a": { numReplicas: 1 },
      };

      expect(regionPlacementPatch("europe-west4-drams3a", placement)).toEqual({
        "europe-west4-drams3a": { numReplicas: 1 },
        "asia-southeast1-eqsg3a": null,
      });
    });

    it("keeps an existing replica count on the target region", () => {
      expect(
        regionPlacementPatch("us-west2", {
          "us-west2": { numReplicas: 3 },
          "us-east4-eqdc4a": { numReplicas: 1 },
        }),
      ).toEqual({
        "us-west2": { numReplicas: 3 },
        "us-east4-eqdc4a": null,
      });
    });

    it("leaves a service that is already only in the requested region", () => {
      expect(
        regionPlacementPatch("us-west2", {
          "us-west2": { numReplicas: 2 },
          "europe-west4-drams3a": null,
        }),
      ).toBeUndefined();
    });

    it("uses the legacy replica count when placement is empty", () => {
      expect(regionPlacementPatch("us-west2", {}, 4)).toEqual({
        "us-west2": { numReplicas: 4 },
      });
    });

    it("sets the replica count on the requested region", () => {
      expect(
        regionPlacementPatch(
          "europe-west4-drams3a",
          { "asia-southeast1-eqsg3a": { numReplicas: 1 } },
          undefined,
          3,
        ),
      ).toEqual({
        "europe-west4-drams3a": { numReplicas: 3 },
        "asia-southeast1-eqsg3a": null,
      });
    });

    it("scales a service that is already only in the requested region", () => {
      expect(
        regionPlacementPatch("us-west2", { "us-west2": { numReplicas: 1 } }, undefined, 2),
      ).toEqual({ "us-west2": { numReplicas: 2 } });
    });

    it("leaves a service that already has the requested count", () => {
      expect(
        regionPlacementPatch(
          "us-west2",
          { "us-west2": { numReplicas: 2 }, "europe-west4-drams3a": null },
          undefined,
          2,
        ),
      ).toBeUndefined();
    });

    it("collapses replicas spread over several regions into the requested one", () => {
      expect(
        regionPlacementPatch(
          "us-west2",
          { "us-west2": { numReplicas: 1 }, "europe-west4-drams3a": { numReplicas: 1 } },
          undefined,
          2,
        ),
      ).toEqual({ "us-west2": { numReplicas: 2 }, "europe-west4-drams3a": null });
    });

    it("totals the replicas Railway is placing", () => {
      expect(observedReplicas({})).toBeUndefined();
      expect(observedReplicas({ "us-west2": null, "europe-west4-drams3a": {} })).toBeUndefined();
      expect(
        observedReplicas({
          "us-west2": { numReplicas: 2 },
          "europe-west4-drams3a": { numReplicas: 1 },
          "asia-southeast1-eqsg3a": null,
        }),
      ).toEqual(3);
    });

    it("scales the one region the service is in when region is omitted", () => {
      const placement = { "us-west2": { numReplicas: 1 }, "europe-west4-drams3a": null };
      expect(placementTarget({ region: undefined, placement })).toEqual({
        _tag: "region",
        region: "us-west2",
      });
      expect(placementTarget({ region: "europe-west4-drams3a", placement })).toEqual({
        _tag: "region",
        region: "europe-west4-drams3a",
      });
    });

    it("uses the legacy region while the placement map is empty", () => {
      expect(placementTarget({ region: undefined, placement: {}, legacy: "us-west2" })).toEqual({
        _tag: "region",
        region: "us-west2",
      });
    });

    it("defers a fresh service with no region only when asked to", () => {
      expect(placementTarget({ region: undefined, placement: {}, deferIfUnknown: true })).toEqual({
        _tag: "defer",
      });
      expect(placementTarget({ region: undefined, placement: {} })).toEqual({
        _tag: "unknown",
        regions: [],
      });
    });

    it("never defers replicas spread over several regions", () => {
      expect(
        placementTarget({
          region: undefined,
          placement: { "us-west2": { numReplicas: 1 }, "europe-west4-drams3a": { numReplicas: 1 } },
          deferIfUnknown: true,
        }),
      ).toEqual({ _tag: "unknown", regions: ["us-west2", "europe-west4-drams3a"] });
    });

    it.effect("rejects a replica count Railway would not place", () =>
      Effect.gen(function* () {
        for (const replicas of [0, -1, 1.5, Number.NaN]) {
          const error = yield* validateReplicas("service", replicas).pipe(Effect.flip);
          expect(error).toBeInstanceOf(ServiceReplicasInvalid);
          expect(error._tag).toBe("Railway.ServiceReplicasInvalid");
        }
        expect(yield* validateReplicas("service", 3)).toEqual(3);
        expect(yield* validateReplicas("service", undefined)).toBeUndefined();
      }),
    );
  },
);
