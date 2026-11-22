import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { FakeRenderServer } from "./FakeRenderServer.ts";

const fake = new FakeRenderServer();
const t = Test.make({ providers: fake.providersLayer() });
t.afterAll(Effect.sync(() => fake.stop()));
const { test } = t;

describe(
  "Render Project & Environment",
  { tags: ["provider:render", "local"], timeout: 60_000 },
  () => {
    test.provider(
      "creates, updates inline environments, looks up, lists, and deletes Project + Environment",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const project = yield* Render.Project("CoreProject", {
                name: "render-core-app",
                environments: {
                  production: {
                    name: "production",
                    protectedStatus: "protected",
                    networkIsolated: true,
                    ipAllowList: [{ cidrBlock: "203.0.113.0/24", description: "office" }],
                  },
                },
              });
              const extraEnv = yield* Render.Environment("StandaloneStaging", {
                projectId: project.id,
                name: "standalone-staging",
                protectedStatus: "unprotected",
                networkIsolated: false,
              });
              return { project, extraEnv };
            }),
          );

          expect(deployed.project.name).toBe("render-core-app");
          expect(deployed.project.environments.production.protectedStatus).toBe("protected");
          expect(deployed.project.environments.production.networkIsolated).toBe(true);
          expect(deployed.extraEnv.projectId).toBe(deployed.project.id);

          const projectProvider = yield* Provider.findProvider(Render.Project);
          const foundProj = yield* projectProvider.lookup!({ name: "render-core-app" });
          expect(foundProj?.id).toBe(deployed.project.id);

          const listedProjs = yield* projectProvider.list!();
          expect(listedProjs.map((p) => p.id)).toContain(deployed.project.id);

          const envProvider = yield* Provider.findProvider(Render.Environment);
          const foundEnv = yield* envProvider.lookup!({
            projectId: deployed.project.id,
            name: "standalone-staging",
          });
          expect(foundEnv?.id).toBe(deployed.extraEnv.id);

          // Exercise plan-time Resource.lookup binding inside a downstream stack resource
          const lookupResult = yield* stack.deploy(
            Effect.gen(function* () {
              const project = yield* Render.Project("CoreProject", {
                name: "render-core-app",
                environments: {
                  production: {
                    name: "production",
                    protectedStatus: "protected",
                    networkIsolated: true,
                    ipAllowList: [{ cidrBlock: "203.0.113.0/24", description: "office" }],
                  },
                },
              });
              const extraEnv = yield* Render.Environment("StandaloneStaging", {
                projectId: project.id,
                name: "standalone-staging",
                protectedStatus: "unprotected",
                networkIsolated: false,
              });
              const lookedProj = Render.Project.lookup({ name: "render-core-app" });
              const lookedEnv = Render.Environment.lookup({
                projectId: lookedProj.id,
                name: "standalone-staging",
              });
              return { project, extraEnv, lookedProjId: lookedProj.id, lookedEnvId: lookedEnv.id };
            }),
          );
          expect(lookupResult.lookedProjId).toBe(deployed.project.id);
          expect(lookupResult.lookedEnvId).toBe(deployed.extraEnv.id);

          // Update project: rename and add a second inline environment
          const updated = yield* stack.deploy(
            Effect.gen(function* () {
              const project = yield* Render.Project("CoreProject", {
                name: "render-core-app-v2",
                environments: {
                  production: {
                    name: "production",
                    protectedStatus: "protected",
                    networkIsolated: true,
                  },
                  qa: {
                    name: "qa",
                    protectedStatus: "unprotected",
                    networkIsolated: true,
                  },
                },
              });
              const extraEnv = yield* Render.Environment("StandaloneStaging", {
                projectId: project.id,
                name: "standalone-staging-renamed",
                protectedStatus: "protected",
              });
              return { project, extraEnv };
            }),
          );

          expect(updated.project.id).toBe(deployed.project.id);
          expect(updated.project.name).toBe("render-core-app-v2");
          expect(updated.project.environments.qa.name).toBe("qa");
          expect(updated.extraEnv.id).toBe(deployed.extraEnv.id);
          expect(updated.extraEnv.name).toBe("standalone-staging-renamed");

          // Out-of-band delete of standalone environment returns undefined on lookup/read and recovers on force/update deploy
          fake.deleteOutOfBand("environment", deployed.extraEnv.id);
          expect(yield* envProvider.lookup!({ id: deployed.extraEnv.id })).toBeUndefined();
          const recreated = yield* stack.deploy(
            Effect.gen(function* () {
              const project = yield* Render.Project("CoreProject", {
                name: "render-core-app-v2",
                environments: {
                  production: {
                    name: "production",
                    protectedStatus: "protected",
                    networkIsolated: true,
                  },
                  qa: {
                    name: "qa",
                    protectedStatus: "unprotected",
                    networkIsolated: true,
                  },
                },
              });
              const extraEnv = yield* Render.Environment("StandaloneStaging", {
                projectId: project.id,
                name: "standalone-staging-renamed",
                protectedStatus: "protected",
              });
              return { project, extraEnv };
            }),
            { force: true },
          );
          expect(recreated.extraEnv.id).not.toBe(deployed.extraEnv.id);

          yield* stack.destroy();
          expect(fake.snapshotCounts().projects).toBe(0);
          expect(fake.snapshotCounts().environments).toBe(0);
        }),
      { tags: ["provider:render", "local"], timeout: 60_000 },
    );
  },
);
