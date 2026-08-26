import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as scc from "@distilled.cloud/gcp/securitycenter_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const project = process.env.GOOGLE_PROJECT_ID ?? "alchemy-gcp-testing-83661";

const waitUntilGone = (name: string) =>
  scc.getOrganizationsNotificationConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const organizationOf = () =>
  Effect.gen(function* () {
    const fromEnv = process.env.GOOGLE_ORGANIZATION_ID;
    if (fromEnv && fromEnv.length > 0) {
      return fromEnv.startsWith("organizations/")
        ? fromEnv
        : `organizations/${fromEnv}`;
    }
    let current: string | undefined = `projects/${project}`;
    for (let i = 0; i < 8; i++) {
      if (current === undefined) return "";
      if (current.startsWith("organizations/")) return current;
      current = current.startsWith("projects/")
        ? yield* resourcemanager.getProjects({ name: current }).pipe(
            Effect.map((resource) => resource.parent),
            Effect.catchTag(["NotFound", "Forbidden"], () =>
              Effect.succeed(undefined),
            ),
          )
        : current.startsWith("folders/")
          ? yield* resourcemanager.getFolders({ name: current }).pipe(
              Effect.map((folder) => folder.parent),
              Effect.catchTag(["NotFound", "Forbidden"], () =>
                Effect.succeed(undefined),
              ),
            )
          : undefined;
    }
    return "";
  });

test.provider.skipIf(!hasGcpCreds)(
  "getOrganizationsNotificationConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        scc.getOrganizationsNotificationConfigs({
          name: `${organization}/notificationConfigs/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete an organization notification config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = yield* organizationOf();
      if (organization.length === 0) {
        const error = yield* Effect.flip(
          scc.createOrganizationsNotificationConfigs({
            parent: "organizations/0",
            configId: "alchemy-probe",
            body: {
              pubsubTopic: `projects/${project}/topics/missing`,
              streamingConfig: { filter: 'severity="HIGH"' },
            },
          }),
        );
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const access = yield* scc
        .listOrganizationsNotificationConfigs({
          parent: organization,
          pageSize: 1,
        })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag(["Forbidden", "NotFound"], (error) =>
            Effect.succeed(error._tag),
          ),
        );
      if (access !== "ok") {
        expect(["Forbidden", "NotFound"]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("OrgSccNotify", {});
          const config =
            yield* GCP.Securitycenter.OrganizationsNotificationConfig("High", {
              organization,
              pubsubTopic: topic.name,
              description: "high severity",
              streamingConfig: { filter: 'severity="HIGH"' },
            });
          return { topic, config };
        }),
      );

      expect(created.config.configId).toEqual(expect.any(String));
      expect(created.config.organization).toEqual(organization);
      expect(created.config.name).toEqual(
        `${organization}/notificationConfigs/${created.config.configId}`,
      );
      expect(created.config.description).toEqual("high severity");

      const fetched = yield* scc.getOrganizationsNotificationConfigs({
        name: created.config.name,
      });
      expect(fetched.name).toEqual(created.config.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("OrgSccNotify", {
            topicId: created.topic.topicId,
          });
          const config =
            yield* GCP.Securitycenter.OrganizationsNotificationConfig("High", {
              organization,
              configId: created.config.configId,
              pubsubTopic: topic.name,
              description: "high and critical",
              streamingConfig: {
                filter: 'severity="HIGH" OR severity="CRITICAL"',
              },
            });
          return { topic, config };
        }),
      );

      expect(updated.config.name).toEqual(created.config.name);
      expect(updated.config.description).toEqual("high and critical");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.config.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
