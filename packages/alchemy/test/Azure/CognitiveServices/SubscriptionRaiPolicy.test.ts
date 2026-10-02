import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  name: string;
  threshold: "Low" | "Medium" | "High";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const policy = yield* Azure.CognitiveServices.SubscriptionRaiPolicy(
      "Policy",
      {
        name: props.name,
        mode: "Blocking",
        contentFilters: [
          {
            name: "Violence",
            enabled: true,
            blocking: true,
            severityThreshold: props.threshold,
            source: "Prompt",
          },
        ],
        tags: props.tags,
      },
    );
    return { policy };
  });

// Subscription-scoped policy, no account: $0, seconds.
test.provider(
  "create, update, replace, and delete a subscription rai policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      const get = (raiPolicyName: string) =>
        cognitiveservices.GetSubscriptionRaiPolicy({
          subscriptionId,
          raiPolicyName,
        });
      const violence = (
        p: cognitiveservices.GetSubscriptionRaiPolicyResponse,
      ) =>
        p.properties?.contentFilters?.find(
          (f) => f.name === "Violence" && f.source === "Prompt",
        );

      yield* stack.deploy(
        program({
          name: "alchemy-sub-policy-a",
          threshold: "Medium",
          tags: { env: "test" },
        }),
      );
      const observed = yield* get("alchemy-sub-policy-a");
      expect(violence(observed)?.severityThreshold).toEqual("Medium");
      expect(observed.tags?.env).toEqual("test");

      // In place: threshold and tags.
      yield* stack.deploy(
        program({
          name: "alchemy-sub-policy-a",
          threshold: "Low",
          tags: { env: "prod" },
        }),
      );
      const reobserved = yield* get("alchemy-sub-policy-a");
      expect(violence(reobserved)?.severityThreshold).toEqual("Low");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the name is immutable.
      yield* stack.deploy(
        program({
          name: "alchemy-sub-policy-b",
          threshold: "Low",
          tags: { env: "prod" },
        }),
      );
      expect(
        violence(yield* get("alchemy-sub-policy-b"))?.severityThreshold,
      ).toEqual("Low");
      expect(yield* waitGone(get("alchemy-sub-policy-a"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-sub-policy-b"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
