import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { FakeRenderServer } from "./FakeRenderServer.ts";

describe(
  "Render Config & Access (RegistryCredential, EnvGroup, EnvGroupLink)",
  { tags: ["provider:render", "local"], timeout: 60_000 },
  () => {
    const fake = new FakeRenderServer();
    const t = Test.make({ providers: fake.providersLayer() });
    t.afterAll(Effect.sync(() => fake.stop()));

    t.test.provider(
      "manages RegistryCredential, EnvGroup (preserving generated vars), and EnvGroupLink",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const project = yield* Render.Project("AccessProject", {
                name: "access-project",
                environments: {
                  staging: { name: "staging", protectedStatus: "unprotected" },
                  prod: { name: "prod", protectedStatus: "protected" },
                },
              });
              const cred = yield* Render.RegistryCredential("GhcrCred", {
                name: "ghcr-cred",
                registry: "GITHUB",
                username: "alchemy-ci",
                authToken: Redacted.make("ghp_secret_v1"),
              });
              const api = yield* Render.WebService("TargetApi", {
                name: "access-api",
                plan: "starter",
                region: "oregon",
                environmentId: project.environments.staging.id,
                runtimeSource: {
                  image: {
                    imagePath: "ghcr.io/alchemy/api",
                    tag: "v1",
                    registryCredentialId: cred.id,
                  },
                },
              });
              const envGroup = yield* Render.EnvGroup("SharedVars", {
                name: "shared-vars",
                environmentId: project.environments.staging.id,
                envVars: {
                  PUBLIC_MODE: "staging",
                  SIGNING_KEY: { generateValue: true },
                },
                secretFiles: {
                  "config.json": '{"mode":"staging"}',
                },
              });
              const link = yield* Render.EnvGroupLink("ApiLinks", {
                envGroupId: envGroup.id,
                serviceIds: [api.id],
              });
              return { project, cred, api, envGroup, link };
            }),
          );

          expect(deployed.cred.registry).toBe("GITHUB");
          expect(Redacted.value(deployed.cred.authToken!)).toBe("ghp_secret_v1");
          expect(Redacted.value(deployed.envGroup.envVars.PUBLIC_MODE)).toBe("staging");
          const initialGenerated = Redacted.value(deployed.envGroup.envVars.SIGNING_KEY);
          expect(initialGenerated.length).toBeGreaterThan(0);
          expect(deployed.link.serviceIds).toEqual([deployed.api.id]);

          // Update EnvGroup: add var, keep SIGNING_KEY (must NOT regenerate), move environmentId, update cred & worker link
          const updated = yield* stack.deploy(
            Effect.gen(function* () {
              const project = yield* Render.Project("AccessProject", {
                name: "access-project",
                environments: {
                  staging: { name: "staging", protectedStatus: "unprotected" },
                  prod: { name: "prod", protectedStatus: "protected" },
                },
              });
              const cred = yield* Render.RegistryCredential("GhcrCred", {
                name: "ghcr-cred-v2",
                registry: "DOCKER",
                username: "alchemy-docker",
                authToken: Redacted.make("dckr_pat_v2"),
              });
              const api = yield* Render.WebService("TargetApi", {
                name: "access-api",
                plan: "starter",
                region: "oregon",
                environmentId: project.environments.prod.id,
                runtimeSource: {
                  image: {
                    imagePath: "ghcr.io/alchemy/api",
                    tag: "v2",
                    registryCredentialId: cred.id,
                  },
                },
              });
              const worker = yield* Render.BackgroundWorker("TargetWorker", {
                name: "access-worker",
                plan: "starter",
                region: "oregon",
                environmentId: project.environments.prod.id,
                runtimeSource: {
                  image: { imagePath: "ghcr.io/alchemy/worker", tag: "v1" },
                },
              });
              const envGroup = yield* Render.EnvGroup("SharedVars", {
                name: "shared-vars-v2",
                environmentId: project.environments.prod.id,
                envVars: {
                  PUBLIC_MODE: "prod",
                  SIGNING_KEY: { generateValue: true },
                  NEW_KEY: "enabled",
                },
                secretFiles: {
                  "config.json": '{"mode":"prod"}',
                },
              });
              const link = yield* Render.EnvGroupLink("ApiLinks", {
                envGroupId: envGroup.id,
                serviceIds: [api.id, worker.id],
              });
              return { project, cred, api, worker, envGroup, link };
            }),
          );

          expect(updated.cred.name).toBe("ghcr-cred-v2");
          expect(updated.cred.registry).toBe("DOCKER");
          expect(updated.envGroup.environmentId).toBe(updated.project.environments.prod.id);
          expect(Redacted.value(updated.envGroup.envVars.SIGNING_KEY)).toBe(initialGenerated);
          expect(Redacted.value(updated.envGroup.envVars.NEW_KEY)).toBe("enabled");
          expect(updated.link.serviceIds.sort()).toEqual(
            [updated.api.id, updated.worker.id].sort(),
          );

          yield* stack.destroy();
          expect(fake.snapshotCounts().envGroups).toBe(0);
          expect(fake.snapshotCounts().registryCredentials).toBe(0);
        }),
      { tags: ["provider:render", "local"], timeout: 60_000 },
    );
  },
);
