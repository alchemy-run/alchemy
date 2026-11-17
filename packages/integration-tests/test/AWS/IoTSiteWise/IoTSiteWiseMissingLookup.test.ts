import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:iotsitewise", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (asset, asset model, gateway).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-asset": AWS.IoTSiteWise.Asset.lookup({
          assetId: "11111111-1111-4111-8111-111111111111",
        }).assetId,
        "missing-asset-model": AWS.IoTSiteWise.AssetModel.lookup({ assetModelName: name })
          .assetModelId,
        "missing-gateway": AWS.IoTSiteWise.Gateway.lookup({ gatewayName: name }).gatewayId,
      });
    }),
  { tags, timeout: 180_000 },
);
