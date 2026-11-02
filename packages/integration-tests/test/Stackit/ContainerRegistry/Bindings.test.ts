import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Docker from "@alchemy.run/docker";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as registry from "@distilled.cloud/stackit/registry";
import * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import RegistryHarborBindingsWorker, {
  Images as HarborImages,
  Robot as HarborRobot,
} from "./fixtures/harbor-worker.ts";
import RegistryBindingsWorker, { Images } from "./fixtures/worker.ts";
import { asHarborUser, noHarborIdentity } from "./harbor.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers(), Docker.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/**
 * A fresh workers.dev URL, the created key and its memberships take a while to
 * propagate: retry until the route answers `ok`, then report the last answer so a
 * real failure shows the registry's error.
 */
const callWorker = (url: string, route: string, params: Record<string, string> = {}) =>
  HttpClient.get(`${url}${route}?${new URLSearchParams(params).toString()}`).pipe(
    Effect.timeout("20 seconds"),
    Effect.flatMap((response) => response.json),
    Effect.map((body) => body as Body),
    Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
    Effect.catch((body) => Effect.succeed(body as Body)),
  );

const ManagementStack = Alchemy.Stack(
  "StackitRegistryBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* RegistryBindingsWorker;
    const images = yield* Images;
    return {
      url: worker.url.as<string>(),
      artifactoryId: images.artifactoryId,
      name: images.name,
      projectId: images.projectId,
      region: images.region,
    };
  }),
);

describe.sequential(
  "STACKIT Container Registry management bindings on a Cloudflare Worker",
  { tags: [...stackitTags("containerregistry", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(ManagementStack), { timeout: 600_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(ManagementStack), { timeout: 600_000 });

    const call = (route: string) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        return yield* callWorker(url!, route);
      });

    describe("GetProject", () => {
      test.provider(
        "reads the bound project",
        (_stack) =>
          Effect.gen(function* () {
            const { artifactoryId, name } = yield* stack;
            const body = yield* call("/get-project");
            expectOk(body);
            expect(body.result.id).toBe(artifactoryId);
            expect(body.result.name).toBe(name);
            expect(body.result.state).toBe("Active");
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListProjects", () => {
      test.provider(
        "lists the bound project among its siblings",
        (_stack) =>
          Effect.gen(function* () {
            const { artifactoryId } = yield* stack;
            const body = yield* call("/list-projects");
            expectOk(body);
            expect(body.result.artifactories.map((item: { id: string }) => item.id)).toContain(
              artifactoryId,
            );
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListReplicationAdapters", () => {
      test.provider(
        "lists what the API lists",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region } = yield* stack;
            const body = yield* call("/list-replication-adapters");
            expectOk(body);
            // Out of band, as the deployer.
            const { replication_adapters } = yield* registry.listReplicationAdapters({
              projectId: projectId!,
              regionId: region!,
            });
            expect(replication_adapters.length).toBeGreaterThan(0);
            expect(body.result.replication_adapters).toEqual(replication_adapters);
          }),
        { timeout: 240_000 },
      );
    });
  },
);

const HarborStack = Alchemy.Stack(
  "StackitRegistryHarborBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* RegistryHarborBindingsWorker;
    const images = yield* HarborImages;
    const robot = yield* HarborRobot;
    const registryLogin = {
      server: images.registryHost,
      username: robot.robotName,
      password: robot.secret,
    };
    // One repository each for the read, delete-artifact and delete-repository cases.
    const seed = (id: string, repository: string) =>
      Docker.RemoteImage(id, {
        name: "busybox",
        tag: "1.36",
        alwaysPull: false,
        targetName: Output.interpolate`${images.imagePrefix}/${repository}`,
        targetTag: "v1",
        registry: registryLogin,
      });
    yield* seed("RegistrySeedImage", "seed");
    yield* seed("RegistrySeedDeleteArtifact", "seed-artifact");
    yield* seed("RegistrySeedDeleteRepository", "seed/nested");
    return {
      url: worker.url.as<string>(),
      name: images.name,
      registryUrl: images.url,
    };
  }),
);

describe
  .skipIf(noHarborIdentity)
  .sequential(
    "STACKIT Container Registry image bindings on a Cloudflare Worker",
    { tags: [...stackitTags("containerregistry", "bindings"), "provider:cloudflare"] },
    () => {
      const stack = beforeAll(deploy(HarborStack), { timeout: 600_000 });
      afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(HarborStack), { timeout: 600_000 });

      const call = (route: string, params: Record<string, string> = {}) =>
        Effect.gen(function* () {
          const { url } = yield* stack;
          return yield* callWorker(url!, route, params);
        });

      const onSeed = { repository: "seed", reference: "v1" };

      /** Out of band, as the suite's Harbor identity. */
      const tagsOfSeed = Effect.gen(function* () {
        const { name, registryUrl } = yield* stack;
        const tags = yield* harbor
          .listTags({ project_name: name!, repository_name: "seed", reference: "v1" })
          .pipe(asHarborUser(registryUrl!));
        return tags.map((tag) => tag.name);
      });

      describe("ListRepositories", () => {
        test.provider(
          "lists the pushed repositories",
          (_stack) =>
            Effect.gen(function* () {
              const { name } = yield* stack;
              const body = yield* call("/list-repositories");
              expectOk(body);
              expect(body.result.map((item: { name: string }) => item.name)).toContain(
                `${name}/seed`,
              );
            }),
          { timeout: 240_000 },
        );
      });

      describe("GetRepository", () => {
        test.provider(
          "reads a repository by bare and by full name",
          (_stack) =>
            Effect.gen(function* () {
              const { name } = yield* stack;
              const bare = yield* call("/get-repository", { repository: "seed" });
              expectOk(bare);
              expect(bare.result.name).toBe(`${name}/seed`);
              const full = yield* call("/get-repository", { repository: `${name}/seed` });
              expectOk(full);
              expect(full.result.id).toBe(bare.result.id);
            }),
          { timeout: 240_000 },
        );
      });

      describe("UpdateRepository", () => {
        test.provider(
          "sets the description",
          (_stack) =>
            Effect.gen(function* () {
              const { name, registryUrl } = yield* stack;
              const body = yield* call("/update-repository", {
                repository: "seed",
                description: "alchemy test",
              });
              expectOk(body);
              const live = yield* harbor
                .getRepository({ project_name: name!, repository_name: "seed" })
                .pipe(asHarborUser(registryUrl!));
              expect(live.description).toBe("alchemy test");
            }),
          { timeout: 240_000 },
        );
      });

      describe("ListArtifacts", () => {
        test.provider(
          "lists the pushed artifact with its tag",
          (_stack) =>
            Effect.gen(function* () {
              const body = yield* call("/list-artifacts", { repository: "seed" });
              expectOk(body);
              expect(body.result.length).toBe(1);
              expect(body.result[0].tags.map((tag: { name: string }) => tag.name)).toContain("v1");
            }),
          { timeout: 240_000 },
        );
      });

      describe("GetArtifact", () => {
        test.provider(
          "reads the artifact by tag",
          (_stack) =>
            Effect.gen(function* () {
              const body = yield* call("/get-artifact", onSeed);
              expectOk(body);
              expect(body.result.digest).toMatch(/^sha256:/);
            }),
          { timeout: 240_000 },
        );
      });

      describe("ListTags", () => {
        test.provider(
          "lists the artifact's tags",
          (_stack) =>
            Effect.gen(function* () {
              const body = yield* call("/list-tags", onSeed);
              expectOk(body);
              expect(body.result.map((tag: { name: string }) => tag.name)).toContain("v1");
            }),
          { timeout: 240_000 },
        );
      });

      describe("CreateTag", () => {
        test.provider(
          "adds a tag",
          (_stack) =>
            Effect.gen(function* () {
              const body = yield* call("/create-tag", { ...onSeed, tag: "created" });
              expectOk(body);
              expect(yield* tagsOfSeed).toContain("created");
            }),
          { timeout: 240_000 },
        );
      });

      describe("DeleteTag", () => {
        test.provider(
          "removes the tag and keeps the artifact",
          (_stack) =>
            Effect.gen(function* () {
              const body = yield* call("/delete-tag", { ...onSeed, tag: "created" });
              expectOk(body);
              const tags = yield* tagsOfSeed;
              expect(tags).not.toContain("created");
              expect(tags).toContain("v1");
            }),
          { timeout: 240_000 },
        );
      });

      describe("ScanArtifact", () => {
        test.provider(
          "starts a scan that reaches the artifact's overview",
          (_stack) =>
            Effect.gen(function* () {
              const body = yield* call("/scan-artifact", onSeed);
              expectOk(body);
            }),
          { timeout: 240_000 },
        );
      });

      /** The overview of the scan started above, once it finished. Bounded (~3 min). */
      const finishedScan = call("/list-artifacts", { repository: "seed" }).pipe(
        Effect.map((body) => {
          const overview = Object.values<{ report_id?: string; scan_status?: string }>(
            body.result?.[0]?.scan_overview ?? {},
          )[0];
          return overview;
        }),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (overview) => overview?.scan_status === "Success",
          times: 36,
        }),
      );

      describe("GetScanReport", () => {
        test.provider(
          "reads the finished scan's report",
          (_stack) =>
            Effect.gen(function* () {
              const overview = yield* finishedScan;
              expect(overview?.scan_status).toBe("Success");
              const body = yield* call("/get-scan-report", onSeed);
              expectOk(body);
              expect(Object.keys(body.result).length).toBeGreaterThan(0);
            }),
          { timeout: 300_000 },
        );
      });

      describe("GetScanLog", () => {
        test.provider(
          "reads the finished scan's log",
          (_stack) =>
            Effect.gen(function* () {
              const overview = yield* finishedScan;
              const body = yield* call("/get-scan-log", {
                ...onSeed,
                report: overview?.report_id ?? "",
              });
              expectOk(body);
              expect(typeof body.result).toBe("string");
            }),
          { timeout: 300_000 },
        );
      });

      describe("StopScan", () => {
        test.provider(
          "stops a scan it just started",
          (_stack) =>
            Effect.gen(function* () {
              expectOk(yield* call("/scan-artifact", onSeed));
              const body = yield* call("/stop-scan", onSeed);
              expectOk(body);
            }),
          { timeout: 240_000 },
        );
      });

      describe("DeleteArtifact", () => {
        test.provider(
          "deletes an artifact by tag",
          (_stack) =>
            Effect.gen(function* () {
              const { name, registryUrl } = yield* stack;
              const body = yield* call("/delete-artifact", {
                repository: "seed-artifact",
                reference: "v1",
              });
              expectOk(body);
              const gone = yield* harbor
                .getArtifact({
                  project_name: name!,
                  repository_name: "seed-artifact",
                  reference: "v1",
                })
                .pipe(asHarborUser(registryUrl!), Effect.flip);
              expect(gone._tag).toBe("NotFound");
            }),
          { timeout: 240_000 },
        );
      });

      describe("DeleteRepository", () => {
        test.provider(
          "deletes a nested repository",
          (_stack) =>
            Effect.gen(function* () {
              const { name, registryUrl } = yield* stack;
              const body = yield* call("/delete-repository", { repository: "seed/nested" });
              expectOk(body);
              const gone = yield* harbor
                .getRepository({
                  project_name: name!,
                  repository_name: encodeURIComponent("seed/nested"),
                })
                .pipe(asHarborUser(registryUrl!), Effect.flip);
              expect(gone._tag).toBe("NotFound");
            }),
          { timeout: 240_000 },
        );
      });
    },
  );
