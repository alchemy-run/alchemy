import * as AWS from "@/AWS";
import { AccountSettings } from "@/AWS/SES";
import * as Test from "@/Test/Alchemy";
import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as sesv2 from "@distilled.cloud/aws/sesv2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// `sendingEnabled` is a per-region account setting, so the toggle test runs in
// a region no other AWS suite touches (the suite uses us-west-2, us-east-1,
// eu-west-1, us-east-2, ca-central-1, eu-central-1, and ap-east-1). A leaked
// disable there can't stop any other test — or any real workload — from
// sending.
const ISOLATED_REGION = "eu-west-3";

const inIsolatedRegion = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(AwsRegion, Effect.succeed(ISOLATED_REGION)),
  );

const getSuppressedReasons = sesv2
  .getAccount({})
  .pipe(
    Effect.map(
      (response) => response.SuppressionAttributes?.SuppressedReasons ?? [],
    ),
  );

// Account/region-global singleton: capture the live suppression configuration
// up front and restore it on scope close so the test leaves the account exactly
// as it found it, even if an assertion fails mid-way. Deleting the resource is
// a no-op (it leaves settings in place), so the restore MUST be explicit.
// `exclusive` because this mutates process-global account state.
test.provider(
  "manages the account suppression list in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const originalReasons = yield* getSuppressedReasons;
      yield* Effect.addFinalizer(() =>
        sesv2
          .putAccountSuppressionAttributes({
            SuppressedReasons: originalReasons,
          })
          .pipe(Effect.ignore),
      );

      // Create — converge the account suppression list onto both reasons.
      const created = yield* stack.deploy(
        AccountSettings("Account", {
          suppression: { suppressedReasons: ["BOUNCE", "COMPLAINT"] },
        }),
      );
      expect([...created.suppressedReasons].sort()).toEqual([
        "BOUNCE",
        "COMPLAINT",
      ]);
      expect([...(yield* getSuppressedReasons)].sort()).toEqual([
        "BOUNCE",
        "COMPLAINT",
      ]);

      // Update in place — narrow the suppression list to a single reason.
      const updated = yield* stack.deploy(
        AccountSettings("Account", {
          suppression: { suppressedReasons: ["BOUNCE"] },
        }),
      );
      expect(updated.suppressedReasons).toEqual(["BOUNCE"]);
      expect(yield* getSuppressedReasons).toEqual(["BOUNCE"]);

      // Destroy is a no-op: the account settings remain as last configured
      // until the finalizer restores the captured original.
      yield* stack.destroy();
      expect(yield* getSuppressedReasons).toEqual(["BOUNCE"]);
    }),
  { timeout: 120_000, exclusive: true },
);

const getSendingEnabled = sesv2
  .getAccount({})
  .pipe(Effect.map((response) => response.SendingEnabled ?? false));

const restoreSendingEnabled = (enabled: boolean) =>
  sesv2
    .putAccountSendingAttributes({ SendingEnabled: enabled })
    .pipe(Effect.ignore);

// Toggling `sendingEnabled` pauses ALL sending for the account in that region,
// so this test is pinned to `ISOLATED_REGION`, is `exclusive`, and restores
// the captured value from a finalizer that runs on failure and interruption
// too. Both regions are captured and restored: if the region pin ever stops
// reaching the deploy, the ambient region is put back as well rather than
// silently left disabled.
test.provider(
  "toggles account-level sending in an isolated region",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const originalIsolated = yield* inIsolatedRegion(getSendingEnabled);
      const originalAmbient = yield* getSendingEnabled;
      yield* Effect.addFinalizer(() =>
        Effect.all(
          [
            inIsolatedRegion(restoreSendingEnabled(originalIsolated)),
            restoreSendingEnabled(originalAmbient),
          ],
          { discard: true },
        ),
      );

      // Sending starts enabled; converge it to disabled.
      const disabled = yield* inIsolatedRegion(
        stack.deploy(AccountSettings("Account", { sendingEnabled: false })),
      );
      expect(disabled.sendingEnabled).toBe(false);
      expect(yield* inIsolatedRegion(getSendingEnabled)).toBe(false);

      // Re-enable in place — the same reconciler converges either direction.
      const enabled = yield* inIsolatedRegion(
        stack.deploy(AccountSettings("Account", { sendingEnabled: true })),
      );
      expect(enabled.sendingEnabled).toBe(true);
      expect(yield* inIsolatedRegion(getSendingEnabled)).toBe(true);

      yield* stack.destroy();
    }),
  { timeout: 120_000, exclusive: true },
);
