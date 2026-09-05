import * as GCP from "@/GCP";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
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

const projectMembers = (role: string) =>
  resourcemanager
    .getIamPolicyProjects({
      resource: `projects/${project}`,
      body: { options: { requestedPolicyVersion: 3 } },
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
  "grant and revoke a project role for a service account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const account = yield* GCP.IAM.ServiceAccount("Viewer", {
            displayName: "Alchemy project IAM member test",
          });
          const member = yield* GCP.IAM.ProjectIamMember("ProjectViewer", {
            role: "roles/viewer",
            member: Output.interpolate`serviceAccount:${account.email}`,
          });
          return { account, member };
        }),
      );

      const principal = `serviceAccount:${created.account.email}`;
      expect(created.member.resource).toEqual(`projects/${project}`);
      expect(created.member.role).toEqual("roles/viewer");
      expect(created.member.member).toEqual(principal);
      expect(yield* projectMembers("roles/viewer")).toContain(principal);

      yield* stack.destroy();

      expect(yield* projectMembers("roles/viewer")).not.toContain(principal);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
