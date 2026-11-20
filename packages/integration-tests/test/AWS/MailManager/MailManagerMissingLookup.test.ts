import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:mailmanager", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (address list, archive, ingress point, relay, rule set).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-address-list": AWS.MailManager.AddressList.lookup({ addressListName: name })
          .addressListId,
        "missing-archive": AWS.MailManager.Archive.lookup({ archiveName: name }).archiveId,
        "missing-ingress-point": AWS.MailManager.IngressPoint.lookup({ ingressPointName: name })
          .ingressPointId,
        "missing-relay": AWS.MailManager.Relay.lookup({ relayName: name }).relayId,
        "missing-rule-set": AWS.MailManager.RuleSet.lookup({ ruleSetName: name }).ruleSetId,
      });
    }),
  { tags, timeout: 180_000 },
);
