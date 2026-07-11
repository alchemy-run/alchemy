import * as AWS from "@/AWS";
import { Role } from "@/AWS/IAM/Role.ts";
import { Crl, Profile, TrustAnchor } from "@/AWS/RolesAnywhere";
import * as Test from "@/Test/Vitest";
import * as rolesanywhere from "@distilled.cloud/aws/rolesanywhere";
import { expect } from "@effect/vitest";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  CA1_CERTIFICATE_PEM,
  CA2_CERTIFICATE_PEM,
  CRL1_PEM,
  CRL2_PEM,
} from "./fixtures/certs.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getTrustAnchor on a bogus UUID fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        rolesanywhere.getTrustAnchor({
          trustAnchorId: "00000000-0000-0000-0000-000000000000",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const trustPolicy: AWS.IAM.PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "rolesanywhere.amazonaws.com" },
      Action: ["sts:AssumeRole", "sts:TagSession", "sts:SetSourceIdentity"],
    },
  ],
};

const sessionPolicy = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Deny", Action: "s3:DeleteObject", Resource: "*" }],
});

/** Assert a resource is gone, retrying briefly through eventual consistency. */
const untilGone = <A, E, R>(
  get: Effect.Effect<A | undefined, E, R>,
): Effect.Effect<void, E | Error, R> =>
  Effect.gen(function* () {
    const found = yield* get;
    if (found !== undefined) {
      return yield* Effect.fail(new Error("resource still exists"));
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.fixed("2 seconds").pipe(
        Schedule.both(Schedule.recurs(8)),
      ),
    }),
  );

test.provider(
  "trust anchor + profile + crl full lifecycle (create, update, replace, destroy)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const stackProgram = (props: {
        anchorABundle: string;
        anchorAEnabled: boolean;
        crlData: string;
        crlEnabled: boolean;
        crlOnAnchorB: boolean;
        durationSeconds: Duration.Input;
        sessionPolicy?: string;
      }) =>
        Effect.gen(function* () {
          const role = yield* Role("RolesAnywhereRole", {
            assumeRolePolicyDocument: trustPolicy,
          });
          const anchorA = yield* TrustAnchor("AnchorA", {
            certificateBundle: props.anchorABundle,
            enabled: props.anchorAEnabled,
            tags: { fixture: "rolesanywhere" },
          });
          const anchorB = yield* TrustAnchor("AnchorB", {
            certificateBundle: CA2_CERTIFICATE_PEM,
          });
          const profile = yield* Profile("Profile", {
            roleArns: [role.roleArn],
            durationSeconds: props.durationSeconds,
            sessionPolicy: props.sessionPolicy,
            tags: { fixture: "rolesanywhere" },
          });
          const crl = yield* Crl("Crl", {
            crlData: props.crlData,
            trustAnchorArn: props.crlOnAnchorB
              ? anchorB.trustAnchorArn
              : anchorA.trustAnchorArn,
            enabled: props.crlEnabled,
            tags: { fixture: "rolesanywhere" },
          });
          return { role, anchorA, anchorB, profile, crl };
        });

      // ── Step 1: greenfield create ─────────────────────────────────────
      const first = yield* stack.deploy(
        stackProgram({
          anchorABundle: CA1_CERTIFICATE_PEM,
          anchorAEnabled: true,
          crlData: CRL1_PEM,
          crlEnabled: true,
          crlOnAnchorB: false,
          durationSeconds: "1 hour",
        }),
      );

      expect(first.anchorA.trustAnchorArn).toContain(":trust-anchor/");
      expect(first.anchorA.enabled).toBe(true);
      expect(first.profile.profileArn).toContain(":profile/");
      expect(first.profile.enabled).toBe(true);
      expect(first.profile.roleArns).toEqual([first.role.roleArn]);
      expect(first.crl.crlArn).toContain(":crl/");
      expect(first.crl.trustAnchorArn).toBe(first.anchorA.trustAnchorArn);
      expect(first.crl.enabled).toBe(true);

      // Out-of-band verification via distilled.
      const observedAnchor = yield* rolesanywhere.getTrustAnchor({
        trustAnchorId: first.anchorA.trustAnchorId,
      });
      expect(observedAnchor.trustAnchor.source?.sourceType).toBe(
        "CERTIFICATE_BUNDLE",
      );
      expect(
        observedAnchor.trustAnchor.source?.sourceData !== undefined &&
          "x509CertificateData" in observedAnchor.trustAnchor.source.sourceData
          ? observedAnchor.trustAnchor.source.sourceData.x509CertificateData?.trim()
          : undefined,
      ).toBe(CA1_CERTIFICATE_PEM.trim());
      const observedProfile = yield* rolesanywhere.getProfile({
        profileId: first.profile.profileId,
      });
      expect(observedProfile.profile?.durationSeconds).toBe(3600);
      expect(observedProfile.profile?.roleArns).toEqual([first.role.roleArn]);

      // ── Step 2: in-place updates on every mutable aspect ──────────────
      const second = yield* stack.deploy(
        stackProgram({
          anchorABundle: CA2_CERTIFICATE_PEM, // updateTrustAnchor source
          anchorAEnabled: false, // disableTrustAnchor
          crlData: CRL2_PEM, // updateCrl data
          crlEnabled: false, // disableCrl
          crlOnAnchorB: false,
          durationSeconds: "2 hours", // updateProfile
          sessionPolicy, // updateProfile
        }),
      );

      // Stable identifiers survived the update.
      expect(second.anchorA.trustAnchorId).toBe(first.anchorA.trustAnchorId);
      expect(second.profile.profileId).toBe(first.profile.profileId);
      expect(second.crl.crlId).toBe(first.crl.crlId);
      expect(second.anchorA.enabled).toBe(false);
      expect(second.crl.enabled).toBe(false);

      const updatedAnchor = yield* rolesanywhere.getTrustAnchor({
        trustAnchorId: second.anchorA.trustAnchorId,
      });
      expect(updatedAnchor.trustAnchor.enabled).toBe(false);
      expect(
        updatedAnchor.trustAnchor.source?.sourceData !== undefined &&
          "x509CertificateData" in updatedAnchor.trustAnchor.source.sourceData
          ? updatedAnchor.trustAnchor.source.sourceData.x509CertificateData?.trim()
          : undefined,
      ).toBe(CA2_CERTIFICATE_PEM.trim());
      const updatedProfile = yield* rolesanywhere.getProfile({
        profileId: second.profile.profileId,
      });
      expect(updatedProfile.profile?.durationSeconds).toBe(7200);
      expect(updatedProfile.profile?.sessionPolicy).toBe(sessionPolicy);
      const updatedCrl = yield* rolesanywhere.getCrl({
        crlId: second.crl.crlId,
      });
      expect(updatedCrl.crl.enabled).toBe(false);
      expect(
        new TextDecoder()
          .decode(updatedCrl.crl.crlData ?? new Uint8Array())
          .trim(),
      ).toBe(CRL2_PEM.trim());

      // ── Step 3: moving the CRL to another trust anchor replaces it ────
      // (both anchors stay deployed across the replacement step)
      const third = yield* stack.deploy(
        stackProgram({
          anchorABundle: CA2_CERTIFICATE_PEM,
          anchorAEnabled: false,
          crlData: CRL2_PEM,
          crlEnabled: false,
          crlOnAnchorB: true,
          durationSeconds: "2 hours",
          sessionPolicy,
        }),
      );

      expect(third.crl.crlId).not.toBe(second.crl.crlId);
      expect(third.crl.trustAnchorArn).toBe(third.anchorB.trustAnchorArn);
      // The replaced CRL was deleted.
      yield* untilGone(
        rolesanywhere.getCrl({ crlId: second.crl.crlId }).pipe(
          Effect.map((r) => r.crl),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        ),
      );

      // ── Destroy and verify everything is gone ─────────────────────────
      yield* stack.destroy();
      yield* untilGone(
        rolesanywhere
          .getTrustAnchor({ trustAnchorId: third.anchorA.trustAnchorId })
          .pipe(
            Effect.map((r) => r.trustAnchor),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          ),
      );
      yield* untilGone(
        rolesanywhere.getProfile({ profileId: third.profile.profileId }).pipe(
          Effect.map((r) => r.profile),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        ),
      );
      yield* untilGone(
        rolesanywhere.getCrl({ crlId: third.crl.crlId }).pipe(
          Effect.map((r) => r.crl),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        ),
      );
    }),
  { timeout: 180_000 },
);
