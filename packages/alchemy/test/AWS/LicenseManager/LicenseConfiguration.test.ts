import * as AWS from "@/AWS";
import { LicenseConfiguration } from "@/AWS/LicenseManager";
import * as Test from "@/Test/Vitest";
import * as iam from "@distilled.cloud/aws/iam";
import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// License Manager requires one-time account onboarding: without its
// service-linked role EVERY operation fails with AccessDeniedException
// ("Service role not found..."). Creating the SLR is idempotent — an
// already-onboarded account returns the typed InvalidInputException
// ("has been taken in this account").
const ensureOnboarded = iam
  .createServiceLinkedRole({
    AWSServiceName: "license-manager.amazonaws.com",
  })
  .pipe(Effect.catchTag("InvalidInputException", () => Effect.void));

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getLicenseConfiguration on a bogus ARN fails with LicenseConfigurationNotFound",
  () =>
    Effect.gen(function* () {
      yield* ensureOnboarded;
      const region = yield* yield* AWS.Region;
      const { Account } = yield* sts.getCallerIdentity({});
      const error = yield* Effect.flip(
        licensemanager.getLicenseConfiguration({
          LicenseConfigurationArn: `arn:aws:license-manager:${region}:${Account}:license-configuration:lic-00000000000000000000000000000000`,
        }),
      );
      expect(error._tag).toBe("LicenseConfigurationNotFound");
    }),
  { timeout: 60_000 },
);

// NOTE: CreateLicenseConfiguration has a small DAILY account quota (~10
// creates/day, deletes do not refund it). The two lifecycle tests below
// consume 3 creates per run, so repeated same-day runs eventually fail
// with the typed ResourceLimitExceededException ("maximum allowed number
// of license configurations created in one day"). That is quota, not a
// bug — re-run the next day.
const isLive = (status: string | undefined) => status !== "DELETED";

// Out-of-band read via distilled; DELETED (soft-deleted) counts as gone.
const getLive = (arn: string) =>
  licensemanager.getLicenseConfiguration({ LicenseConfigurationArn: arn }).pipe(
    Effect.map((r) => (isLive(r.Status) ? r : undefined)),
    Effect.catchTag("LicenseConfigurationNotFound", () =>
      Effect.succeed(undefined),
    ),
  );

test.provider(
  "create, update, and delete a license configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* ensureOnboarded;
      yield* stack.destroy();

      // Create — vCPU counting, soft count.
      const { licenses } = yield* stack.deploy(
        Effect.gen(function* () {
          const licenses = yield* LicenseConfiguration("Licenses", {
            licenseCountingType: "vCPU",
            licenseCount: 10,
            description: "alchemy license-manager test",
            tags: { fixture: "license-configuration" },
          });
          return { licenses };
        }),
      );

      expect(licenses.licenseConfigurationId).toMatch(/^lic-/);
      expect(licenses.licenseConfigurationArn).toContain(
        ":license-configuration:",
      );
      expect(licenses.licenseCountingType).toBe("vCPU");

      // Out-of-band verification via distilled.
      const observed = yield* licensemanager.getLicenseConfiguration({
        LicenseConfigurationArn: licenses.licenseConfigurationArn,
      });
      expect(observed.Name).toBe(licenses.name);
      expect(observed.LicenseCountingType).toBe("vCPU");
      expect(observed.LicenseCount).toBe(10);
      expect(observed.LicenseCountHardLimit).toBe(false);
      const tags = Object.fromEntries(
        (observed.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tags.fixture).toBe("license-configuration");
      expect(tags["alchemy::id"]).toBe("Licenses");

      // Update in place — count, hard limit, description, tags.
      const { licenses: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const licenses = yield* LicenseConfiguration("Licenses", {
            licenseCountingType: "vCPU",
            licenseCount: 20,
            licenseCountHardLimit: true,
            description: "alchemy license-manager test (updated)",
            tags: { fixture: "license-configuration", phase: "two" },
          });
          return { licenses };
        }),
      );

      // Same physical resource — update, not replace.
      expect(updated.licenseConfigurationArn).toBe(
        licenses.licenseConfigurationArn,
      );
      const afterUpdate = yield* licensemanager.getLicenseConfiguration({
        LicenseConfigurationArn: licenses.licenseConfigurationArn,
      });
      expect(afterUpdate.LicenseCount).toBe(20);
      expect(afterUpdate.LicenseCountHardLimit).toBe(true);
      expect(afterUpdate.Description).toBe(
        "alchemy license-manager test (updated)",
      );
      const updatedTags = Object.fromEntries(
        (afterUpdate.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(updatedTags.phase).toBe("two");

      // Destroy and verify deletion out-of-band (soft-delete counts).
      yield* stack.destroy();
      const gone = yield* getLive(licenses.licenseConfigurationArn);
      expect(gone).toBeUndefined();
    }),
  { timeout: 120_000 },
);

test.provider(
  "changing licenseCountingType replaces the license configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* ensureOnboarded;
      yield* stack.destroy();

      const { licenses: first } = yield* stack.deploy(
        Effect.gen(function* () {
          const licenses = yield* LicenseConfiguration("Replaceable", {
            licenseCountingType: "Instance",
            licenseCount: 2,
          });
          return { licenses };
        }),
      );
      expect(first.licenseCountingType).toBe("Instance");

      const { licenses: second } = yield* stack.deploy(
        Effect.gen(function* () {
          const licenses = yield* LicenseConfiguration("Replaceable", {
            licenseCountingType: "Core",
            licenseCount: 2,
          });
          return { licenses };
        }),
      );

      expect(second.licenseCountingType).toBe("Core");
      expect(second.licenseConfigurationArn).not.toBe(
        first.licenseConfigurationArn,
      );

      // The replaced (old) configuration is deleted.
      const old = yield* getLive(first.licenseConfigurationArn);
      expect(old).toBeUndefined();

      yield* stack.destroy();
      const gone = yield* getLive(second.licenseConfigurationArn);
      expect(gone).toBeUndefined();
    }),
  { timeout: 120_000 },
);
