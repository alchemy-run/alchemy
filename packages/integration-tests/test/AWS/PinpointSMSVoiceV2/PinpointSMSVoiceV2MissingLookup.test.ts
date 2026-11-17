import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:pinpointsmsvoicev2", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (configuration set, opt out list, phone number).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-configuration-set": AWS.PinpointSMSVoiceV2.ConfigurationSet.lookup({
          configurationSetName: name,
        }).configurationSetName,
        "missing-opt-out-list": AWS.PinpointSMSVoiceV2.OptOutList.lookup({ optOutListName: name })
          .optOutListName,
        "missing-phone-number": AWS.PinpointSMSVoiceV2.PhoneNumber.lookup({
          phoneNumberId: "phone-00000000000000000000000000000000",
        }).phoneNumberId,
      });
    }),
  { tags, timeout: 180_000 },
);
