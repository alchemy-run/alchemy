import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as datashare from "@distilled.cloud/azure/datashare";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { chain, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSubscription = (
  resourceGroupName: string,
  accountName: string,
  shareSubscriptionName: string,
) =>
  Effect.gen(function* () {
    return yield* datashare.GetShareSubscription({
      subscriptionId: yield* subscription,
      resourceGroupName,
      accountName,
      shareSubscriptionName,
    });
  });

// Free Data Share objects + an empty Standard_LRS storage account. The
// invitation targets the deploying service principal, which accepts it.
// ~4-6 minutes.
test.provider(
  "accept, replace, and delete a share subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(chain({ consumer: true }));
      const { group, share, invitation } = first;
      const consumer = first.consumer!;
      const sub = first.subscription!;
      expect(sub.invitationId).toEqual(invitation.invitationId);
      expect(sub.shareSubscriptionStatus).toEqual("Active");
      expect(sub.shareName).toEqual(share.shareName);
      expect(sub.shareKind).toEqual("CopyBased");
      const observed = yield* getSubscription(
        group.resourceGroupName,
        consumer.accountName,
        sub.shareSubscriptionName,
      );
      expect(observed.properties.invitationId).toEqual(invitation.invitationId);
      expect(observed.properties.shareName).toEqual(share.shareName);

      // Replacement: accept another invitation.
      const second = yield* stack.deploy(
        chain({ consumer: true, invitation: "Invitation2" }),
      );
      const sub2 = second.subscription!;
      expect(sub2.shareSubscriptionId).not.toEqual(sub.shareSubscriptionId);
      expect(sub2.invitationId).not.toEqual(invitation.invitationId);
      const reobserved = yield* getSubscription(
        group.resourceGroupName,
        consumer.accountName,
        sub2.shareSubscriptionName,
      );
      expect(reobserved.properties.invitationId).toEqual(sub2.invitationId);
      expect(
        yield* waitGone(
          getSubscription(
            group.resourceGroupName,
            consumer.accountName,
            sub.shareSubscriptionName,
          ),
          6,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getSubscription(
            group.resourceGroupName,
            consumer.accountName,
            sub2.shareSubscriptionName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
