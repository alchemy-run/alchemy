import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as datashare from "@distilled.cloud/azure/datashare";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { description: string; terms?: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.DataShare.Account("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const share = yield* Azure.DataShare.Share("Share", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      description: props.description,
      terms: props.terms,
    });
    return { group, account, share };
  });

// Data Share accounts and shares are free; ~2 minutes.
test.provider(
  "create, update, and delete a share",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, share } = yield* stack.deploy(
        program({ description: "first" }),
      );
      const get = (shareName: string) =>
        Effect.gen(function* () {
          return yield* datashare.GetShare({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            accountName: account.accountName,
            shareName,
          });
        });
      expect(share.shareKind).toEqual("CopyBased");
      expect((yield* get(share.shareName)).properties?.description).toEqual(
        "first",
      );

      // In-place: description and terms.
      const updated = yield* stack.deploy(
        program({ description: "second", terms: "internal use only" }),
      );
      expect(updated.share.shareId).toEqual(share.shareId);
      const observed = yield* get(share.shareName);
      expect(observed.properties?.description).toEqual("second");
      expect(observed.properties?.terms).toEqual("internal use only");

      yield* stack.destroy();
      expect(yield* waitGone(get(share.shareName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
