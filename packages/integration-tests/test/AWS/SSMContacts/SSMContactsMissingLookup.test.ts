import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:ssmcontacts", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (contact, contact channel, rotation).
// The testing account can't use SSMContacts; an entitled account sets the gate.
test.provider.skipIf(!process.env.AWS_TEST_INCIDENT_MANAGER)(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const { accountId, region } = yield* AWSEnvironment.current;
      yield* expectAllMissing(stack, {
        "missing-contact": AWS.SSMContacts.Contact.lookup({ alias: name }).contactArn,
        "missing-contact-channel": AWS.SSMContacts.ContactChannel.lookup({
          contactChannelArn: `arn:aws:ssm-contacts:${region}:${accountId}:contact-channel/missing-lookup/11111111-1111-4111-8111-111111111111`,
        }).contactChannelArn,
        "missing-rotation": AWS.SSMContacts.Rotation.lookup({ name: name }).rotationArn,
      });
    }),
  { tags, timeout: 180_000 },
);
