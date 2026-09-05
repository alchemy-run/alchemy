import * as GCP from "@/GCP";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const hasGcpCreds = !!(
  project &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const accountMembers = (resource: string, role: string) =>
  iam
    .getIamPolicyProjectsServiceAccounts({
      resource,
      "options.requestedPolicyVersion": 3,
    })
    .pipe(
      Effect.map(
        (policy) =>
          policy.bindings?.find(
            (binding) =>
              binding.role === role && binding.condition === undefined,
          )?.members ?? [],
      ),
    );

test.provider.skipIf(!hasGcpCreds)(
  "grant and revoke a role on a service account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const account = yield* GCP.IAM.ServiceAccount("Runner", {
            displayName: "Alchemy service account IAM member test",
          });
          const member = yield* GCP.IAM.ServiceAccountIamMember(
            "SelfTokenCreator",
            {
              serviceAccount: account.name,
              role: "roles/iam.serviceAccountTokenCreator",
              member: Output.interpolate`serviceAccount:${account.email}`,
            },
          );
          return { account, member };
        }),
      );

      const principal = `serviceAccount:${created.account.email}`;
      expect(created.member.resource).toEqual(created.account.name);
      expect(created.member.role).toEqual(
        "roles/iam.serviceAccountTokenCreator",
      );
      expect(created.member.member).toEqual(principal);
      expect(
        yield* accountMembers(
          created.account.name,
          "roles/iam.serviceAccountTokenCreator",
        ),
      ).toContain(principal);

      // Revoke the grant while keeping the account so the policy can be
      // observed after the member row is deleted.
      const revoked = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.IAM.ServiceAccount("Runner", {
            accountId: created.account.accountId,
            displayName: "Alchemy service account IAM member test",
          });
        }),
      );
      expect(revoked.name).toEqual(created.account.name);
      expect(
        yield* accountMembers(
          created.account.name,
          "roles/iam.serviceAccountTokenCreator",
        ),
      ).not.toContain(principal);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
