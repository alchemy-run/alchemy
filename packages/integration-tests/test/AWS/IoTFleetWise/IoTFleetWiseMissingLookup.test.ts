import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:iotfleetwise", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (campaign, decoder manifest, fleet, model manifest, signal catalog, state template, vehicle).
// The testing account can't use IoTFleetWise; an entitled account sets the gate.
test.provider.skipIf(!process.env.AWS_TEST_IOTFLEETWISE)(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-campaign": AWS.IoTFleetWise.Campaign.lookup({ campaignName: name }).campaignName,
        "missing-decoder-manifest": AWS.IoTFleetWise.DecoderManifest.lookup({
          decoderManifestName: name,
        }).decoderManifestName,
        "missing-fleet": AWS.IoTFleetWise.Fleet.lookup({ fleetId: name }).fleetId,
        "missing-model-manifest": AWS.IoTFleetWise.ModelManifest.lookup({ modelManifestName: name })
          .modelManifestName,
        "missing-signal-catalog": AWS.IoTFleetWise.SignalCatalog.lookup({ signalCatalogName: name })
          .signalCatalogName,
        "missing-state-template": AWS.IoTFleetWise.StateTemplate.lookup({ stateTemplateName: name })
          .stateTemplateName,
        "missing-vehicle": AWS.IoTFleetWise.Vehicle.lookup({ vehicleName: name }).vehicleName,
      });
    }),
  { tags, timeout: 180_000 },
);
