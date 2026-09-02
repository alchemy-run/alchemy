import * as GCP from "@/GCP";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

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

const secretMembers = (resource: string, role: string) =>
  secretmanager
    .getIamPolicyProjectsSecrets({
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

const waitUntilGone = (name: string) =>
  secretmanager.getProjectsSecrets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "grant and revoke a role on a secret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const secret = yield* GCP.SecretManager.Secret("ApiKey", {});
          const account = yield* GCP.IAM.ServiceAccount("Reader", {
            displayName: "Alchemy secret IAM member test",
          });
          const member = yield* GCP.IAM.SecretIamMember("SecretReader", {
            secret: secret.name,
            role: "roles/secretmanager.secretAccessor",
            member: Output.interpolate`serviceAccount:${account.email}`,
          });
          return { secret, account, member };
        }),
      );

      const principal = `serviceAccount:${created.account.email}`;
      expect(created.member.resource).toEqual(created.secret.name);
      expect(created.member.role).toEqual("roles/secretmanager.secretAccessor");
      expect(created.member.member).toEqual(principal);
      expect(
        yield* secretMembers(
          created.secret.name,
          "roles/secretmanager.secretAccessor",
        ),
      ).toContain(principal);

      // Revoke the grant while keeping the secret so the policy can be
      // observed after the member row is deleted.
      const revoked = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecretManager.Secret("ApiKey", {
            secretId: created.secret.secretId,
          });
        }),
      );
      expect(revoked.name).toEqual(created.secret.name);
      expect(
        yield* secretMembers(
          created.secret.name,
          "roles/secretmanager.secretAccessor",
        ),
      ).not.toContain(principal);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.secret.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
