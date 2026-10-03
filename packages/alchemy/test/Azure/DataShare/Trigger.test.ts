import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as datashare from "@distilled.cloud/azure/datashare";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { chain, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getTrigger = (
  resourceGroupName: string,
  accountName: string,
  shareSubscriptionName: string,
  triggerName: string,
) =>
  Effect.gen(function* () {
    return yield* datashare.GetTrigger({
      subscriptionId: yield* subscription,
      resourceGroupName,
      accountName,
      shareSubscriptionName,
      triggerName,
    });
  });

// Free Data Share objects + an empty Standard_LRS storage account; the
// trigger's first snapshot is scheduled in the past-anchored daily slot and
// the share is empty, so no data movement is billed. ~4-6 minutes.
test.provider(
  "create, replace, and delete a snapshot trigger",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        chain({ consumer: true, trigger: "Incremental" }),
      );
      const { group, consumer, subscription: sub } = first;
      const trigger = first.trigger!;
      expect(trigger.recurrenceInterval).toEqual("Day");
      expect(trigger.synchronizationMode).toEqual("Incremental");
      expect(trigger.provisioningState).toEqual("Succeeded");
      const observed = yield* getTrigger(
        group.resourceGroupName,
        consumer!.accountName,
        sub!.shareSubscriptionName,
        trigger.triggerName,
      );
      expect(observed.kind).toEqual("ScheduleBased");
      expect(
        (observed.properties as { synchronizationMode?: string })
          .synchronizationMode,
      ).toEqual("Incremental");

      // Replacement: triggers are immutable.
      const second = yield* stack.deploy(
        chain({ consumer: true, trigger: "FullSync" }),
      );
      expect(second.trigger!.triggerId).not.toEqual(trigger.triggerId);
      expect(second.trigger!.synchronizationMode).toEqual("FullSync");
      const reobserved = yield* getTrigger(
        group.resourceGroupName,
        consumer!.accountName,
        sub!.shareSubscriptionName,
        second.trigger!.triggerName,
      );
      expect(
        (reobserved.properties as { synchronizationMode?: string })
          .synchronizationMode,
      ).toEqual("FullSync");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getTrigger(
            group.resourceGroupName,
            consumer!.accountName,
            sub!.shareSubscriptionName,
            second.trigger!.triggerName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
