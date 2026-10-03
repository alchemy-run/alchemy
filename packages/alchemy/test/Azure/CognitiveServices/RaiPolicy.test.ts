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
  withBlocklist: boolean;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.CognitiveServices.Account("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const blocklist = yield* Azure.CognitiveServices.RaiBlocklist("Blocklist", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
    });
    const policy = yield* Azure.CognitiveServices.RaiPolicy("Policy", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      name: props.name,
      mode: "Blocking",
      contentFilters: [
        {
          name: "Hate",
          enabled: true,
          blocking: true,
          severityThreshold: props.threshold,
          source: "Prompt",
        },
        {
          name: "Hate",
          enabled: true,
          blocking: true,
          severityThreshold: props.threshold,
          source: "Completion",
        },
      ],
      customBlocklists: props.withBlocklist
        ? [
            {
              blocklistName: blocklist.raiBlocklistName,
              blocking: true,
              source: "Prompt",
            },
          ]
        : [],
      tags: { env: "test" },
    });
    return { group, account, blocklist, policy };
  });

// S0 AIServices account + blocklist + policy: $0 idle, ~1 minute.
test.provider(
  "create, update, replace, and delete a rai policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;

      const { group, account, policy } = yield* stack.deploy(
        program({
          name: "alchemy-policy-a",
          threshold: "Medium",
          withBlocklist: false,
        }),
      );
      const get = (raiPolicyName: string) =>
        cognitiveservices.GetRaiPolicy({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          accountName: account.accountName,
          raiPolicyName,
        });
      expect(policy.basePolicyName).toEqual("Microsoft.DefaultV2");
      const observed = yield* get("alchemy-policy-a");
      const hate = (p: typeof observed) =>
        p.properties?.contentFilters?.find(
          (f) => f.name === "Hate" && f.source === "Prompt",
        );
      expect(hate(observed)?.severityThreshold).toEqual("Medium");
      expect(observed.properties?.customBlocklists ?? []).toEqual([]);

      // In place: threshold and a custom blocklist.
      const updated = yield* stack.deploy(
        program({
          name: "alchemy-policy-a",
          threshold: "Low",
          withBlocklist: true,
        }),
      );
      const reobserved = yield* get("alchemy-policy-a");
      expect(hate(reobserved)?.severityThreshold).toEqual("Low");
      expect(reobserved.properties?.customBlocklists).toEqual([
        {
          blocklistName: updated.blocklist.raiBlocklistName,
          blocking: true,
          source: "Prompt",
        },
      ]);

      // Replacement: the name is immutable.
      yield* stack.deploy(
        program({
          name: "alchemy-policy-b",
          threshold: "Low",
          withBlocklist: true,
        }),
      );
      expect(hate(yield* get("alchemy-policy-b"))?.severityThreshold).toEqual(
        "Low",
      );
      expect(yield* waitGone(get("alchemy-policy-a"))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          cognitiveservices.GetAccount({
            subscriptionId,
            resourceGroupName: group.resourceGroupName,
            accountName: account.accountName,
          }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
