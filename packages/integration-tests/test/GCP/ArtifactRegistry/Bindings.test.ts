import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { expectProbe } from "../bindingHost.ts";
import ArtifactRegistryBindingsHost, {
  Apt,
  Googet,
  Images,
  Maven,
  Npm,
  Packages,
  Python,
  Yum,
} from "./fixtures/bindings-host.ts";
import { IMAGE, pushDockerVersion } from "./registry.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ArtifactRegistryBindings");

let baseUrl: string;
let hostAccount: string;
type RepositoryRef = {
  name: string;
  repositoryId: string;
  project: string;
  location: string;
};
let repository: RepositoryRef;
let packages: RepositoryRef;
let formats: Record<"maven" | "npm" | "python" | "apt" | "yum" | "googet", string>;

const repositoryRoles = Effect.fn(function* (resource: string) {
  const policy = yield* artifactregistry.getIamPolicyProjectsLocationsRepositories({
    resource,
    "options.requestedPolicyVersion": 3,
  });
  return (policy.bindings ?? [])
    .filter((binding) => (binding.members ?? []).includes(`serviceAccount:${hostAccount}`))
    .map((binding) => binding.role)
    .sort();
});

/** Every project-level role (and its IAM Condition) `account` holds. */
const projectGrantsOf = (account: string) =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;
    const policy = yield* resourcemanager.getIamPolicyProjects({
      resource: `projects/${project}`,
      body: { options: { requestedPolicyVersion: 3 } },
    });
    return (policy.bindings ?? [])
      .filter((binding) => (binding.members ?? []).includes(`serviceAccount:${account}`))
      .map((binding) => ({
        role: binding.role,
        condition: binding.condition?.expression,
      }));
  });

describe(
  "ArtifactRegistry Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:artifactregistry", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* ArtifactRegistryBindingsHost;
            const images = yield* Images;
            return {
              packages: yield* Effect.map(Packages, (r) => ({
                name: r.name,
                repositoryId: r.repositoryId,
                project: r.project,
                location: r.location,
              })),
              formats: {
                maven: (yield* Maven).name,
                npm: (yield* Npm).name,
                python: (yield* Python).name,
                apt: (yield* Apt).name,
                yum: (yield* Yum).name,
                googet: (yield* Googet).name,
              },
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              repository: {
                name: images.name,
                repositoryId: images.repositoryId,
                project: images.project,
                location: images.location,
              },
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        repository = out.repository;
        packages = out.packages;
        formats = out.formats;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    const live = {
      tags: ["provider:gcp", "provider:gcp:artifactregistry", "live"],
      timeout: 600_000,
    };

    describe("ListDockerImages", () => {
      test.provider(
        "lists a pushed image as the host's service account, granted on the repository only",
        (_stack) =>
          Effect.gen(function* () {
            const version = yield* pushDockerVersion(repository, "v1");
            const digest = version.split("/versions/")[1]!;

            const page = yield* expectProbe<{
              dockerImages?: Array<{ name?: string; uri?: string }>;
            }>(baseUrl, "listDockerImages").pipe(
              // The pushed image is listed once the registry indexes it.
              Effect.repeat({
                schedule: Schedule.spaced("3 seconds"),
                until: (result) => (result.dockerImages ?? []).length > 0,
                times: 10,
              }),
            );
            expect((page.dockerImages ?? []).map((image) => image.uri)).toEqual([
              `${repository.location}-docker.pkg.dev/${repository.project}/${repository.repositoryId}/${IMAGE}@${digest}`,
            ]);

            const policy = yield* artifactregistry.getIamPolicyProjectsLocationsRepositories({
              resource: repository.name,
              "options.requestedPolicyVersion": 3,
            });
            const roles = (policy.bindings ?? [])
              .filter((binding) =>
                (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
              )
              .map((binding) => binding.role);
            expect(roles).toEqual(["roles/artifactregistry.reader"]);
            expect(yield* projectGrantsOf(hostAccount)).toEqual([]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:artifactregistry", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("Packages, versions, tags, files and docker images", () => {
      test.provider(
        "reads, annotates, tags and deletes a pushed image as the host, granted on the repository only",
        (_stack) =>
          Effect.gen(function* () {
            const first = yield* pushDockerVersion(packages, "first");
            const second = yield* pushDockerVersion(packages, "second");
            const versionId = (name: string) => name.split("/versions/")[1]!;
            const q = (params: Record<string, string>) =>
              new URLSearchParams({ package: IMAGE, ...params }).toString();

            const repo = yield* expectProbe<{ name?: string; format?: string }>(
              baseUrl,
              "getRepository",
            );
            expect(repo).toMatchObject({ name: packages.name, format: "DOCKER" });

            const listed = yield* expectProbe<{ packages?: { name?: string }[] }>(
              baseUrl,
              "listPackages",
            ).pipe(
              // A pushed image is listed once the registry indexes it.
              Effect.repeat({
                schedule: Schedule.spaced("3 seconds"),
                until: (out) => (out.packages ?? []).length > 0,
                times: 10,
              }),
            );
            const packageName = `${packages.name}/packages/${IMAGE}`;
            expect(listed.packages?.map((p) => p.name)).toEqual([packageName]);
            expect(
              (yield* expectProbe<{ name?: string }>(baseUrl, `getPackage?${q({})}`)).name,
            ).toEqual(packageName);
            const annotated = yield* expectProbe<{ annotations?: Record<string, string> }>(
              baseUrl,
              `patchPackage?${q({})}`,
            );
            expect(annotated.annotations).toEqual({ "alchemy-binding": "package" });

            const versions = yield* expectProbe<{ versions?: { name?: string }[] }>(
              baseUrl,
              `listVersions?${q({})}`,
            );
            expect(versions.versions?.map((v) => v.name).sort()).toEqual([first, second].sort());
            expect(
              (yield* expectProbe<{ name?: string }>(
                baseUrl,
                `getVersion?${q({ version: versionId(first) })}`,
              )).name,
            ).toEqual(first);
            const patchedVersion = yield* expectProbe<{ annotations?: Record<string, string> }>(
              baseUrl,
              `patchVersion?${q({ version: versionId(first) })}`,
            );
            expect(patchedVersion.annotations).toEqual({ "alchemy-binding": "version" });

            const tags = yield* expectProbe<{ tags?: { name?: string; version?: string }[] }>(
              baseUrl,
              `listTags?${q({})}`,
            );
            expect(tags.tags?.map((t) => t.name).sort()).toEqual(
              ["first", "second"].map((t) => `${packageName}/tags/${t}`),
            );
            expect(
              yield* expectProbe<{ version?: string }>(baseUrl, `getTag?${q({ tag: "first" })}`),
            ).toMatchObject({ version: first });
            const created = yield* expectProbe<{ name?: string; version?: string }>(
              baseUrl,
              `createTag?${q({ tag: "extra", version: first })}`,
            );
            expect(created).toEqual({ name: `${packageName}/tags/extra`, version: first });
            const moved = yield* expectProbe<{ version?: string }>(
              baseUrl,
              `patchTag?${q({ tag: "extra", version: second })}`,
            );
            expect(moved.version).toEqual(second);
            yield* expectProbe(baseUrl, `deleteTag?${q({ tag: "extra" })}`);

            const image = yield* expectProbe<{ uri?: string }>(
              baseUrl,
              `getDockerImage?${new URLSearchParams({ image: `${IMAGE}@${versionId(first)}` })}`,
            );
            expect(image.uri).toContain(`${IMAGE}@${versionId(first)}`);

            const files = yield* expectProbe<{ files?: { name?: string }[] }>(baseUrl, "listFiles");
            const fileName = files.files?.[0]?.name;
            expect(fileName).toBeDefined();
            const fileId = fileName!.split("/files/")[1]!;
            expect(
              (yield* expectProbe<{ name?: string }>(baseUrl, `getFile?${q({ file: fileId })}`))
                .name,
            ).toEqual(fileName);
            const patchedFile = yield* expectProbe<{ annotations?: Record<string, string> }>(
              baseUrl,
              `patchFile?${q({ file: fileId })}`,
            );
            expect(patchedFile.annotations).toEqual({ "alchemy-binding": "file" });
            expect(
              yield* expectProbe<string>(baseUrl, `downloadFile?${q({ file: fileId })}`),
            ).toEqual("succeeded");

            yield* expectProbe(baseUrl, `deleteVersion?${q({ version: versionId(first) })}`);
            yield* expectProbe(baseUrl, `batchDeleteVersions?${q({ version: second })}`);
            yield* expectProbe(baseUrl, `deletePackage?${q({})}`);
            const gone = yield* artifactregistry
              .getProjectsLocationsRepositoriesPackages({ name: packageName })
              .pipe(
                Effect.flip,
                Effect.repeat({
                  schedule: Schedule.spaced("3 seconds"),
                  until: (error) => error._tag === "NotFound",
                  times: 10,
                }),
              );
            expect(gone._tag).toEqual("NotFound");

            expect(yield* repositoryRoles(packages.name)).toEqual([
              "roles/artifactregistry.attachmentReader",
              "roles/artifactregistry.attachmentWriter",
              "roles/artifactregistry.reader",
              "roles/artifactregistry.repoAdmin",
              "roles/artifactregistry.writer",
            ]);
          }),
        live,
      );
    });

    describe("CreateRepositoryRule / GetRepositoryRule / ListRepositoryRules / PatchRepositoryRule / DeleteRepositoryRule", () => {
      test.provider(
        "manages a download rule as the host",
        (_stack) =>
          Effect.gen(function* () {
            const rule = "deny-hello";
            const created = yield* expectProbe<{ name?: string; action?: string }>(
              baseUrl,
              `createRule?rule=${rule}&package=${IMAGE}`,
            );
            expect(created).toMatchObject({
              name: `${packages.name}/rules/${rule}`,
              action: "DENY",
            });
            expect(
              (yield* expectProbe<{ rules?: { name?: string }[] }>(
                baseUrl,
                "listRules",
              )).rules?.map((r) => r.name),
            ).toEqual([created.name]);
            expect(
              yield* expectProbe<{ packageId?: string }>(baseUrl, `getRule?rule=${rule}`),
            ).toMatchObject({ packageId: IMAGE });
            expect(
              (yield* expectProbe<{ action?: string }>(baseUrl, `patchRule?rule=${rule}`)).action,
            ).toEqual("ALLOW");
            yield* expectProbe(baseUrl, `deleteRule?rule=${rule}`);
            const gone = yield* artifactregistry
              .getProjectsLocationsRepositoriesRules({ name: created.name! })
              .pipe(Effect.flip);
            expect(gone._tag).toEqual("NotFound");
          }),
        live,
      );
    });

    describe("CreateRepositoryAttachment / GetRepositoryAttachment / ListRepositoryAttachments / DeleteRepositoryAttachment / ExportRepositoryArtifact", () => {
      test.provider(
        "attaches a file to a version and exports it as the host",
        (_stack) =>
          Effect.gen(function* () {
            const version = yield* pushDockerVersion(packages, "attached");
            const files = yield* artifactregistry.listProjectsLocationsRepositoriesFiles({
              parent: packages.name,
            });
            // Attachments reference blobs (`files/sha256:…`), not manifests.
            const file = files
              .files!.map((f) => f.name!)
              .find((name) => /\/files\/sha256:/.test(name))!;
            const attachment = "binding-note";
            const created = yield* expectProbe<unknown>(
              baseUrl,
              `createAttachment?${new URLSearchParams({ attachment, version, file })}`,
            );
            expect(created).toBeDefined();
            const name = `${packages.name}/attachments/${attachment}`;
            const listed = yield* expectProbe<{ attachments?: { name?: string }[] }>(
              baseUrl,
              "listAttachments",
            ).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("3 seconds"),
                until: (out) => (out.attachments ?? []).length > 0,
                times: 10,
              }),
            );
            expect(listed.attachments?.map((a) => a.name)).toEqual([name]);
            expect(
              yield* expectProbe<{ target?: string }>(
                baseUrl,
                `getAttachment?attachment=${attachment}`,
              ),
            ).toMatchObject({ target: version });
            yield* expectProbe(baseUrl, `deleteAttachment?attachment=${attachment}`);

            // The bucket doesn't exist: the export is authorized and fails on its destination.
            expect(
              yield* expectProbe<string>(
                baseUrl,
                `exportArtifact?${new URLSearchParams({ version })}`,
              ),
            ).not.toEqual("Forbidden");
          }),
        live,
      );
    });

    describe("Maven, npm and Python packages / Apt, Yum and GooGet imports", () => {
      test.provider(
        "reads format repositories and starts imports as the host, granted on each repository only",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{
              maven: { mavenArtifacts?: unknown[] };
              mavenMissing: string;
              npm: { npmPackages?: unknown[] };
              npmMissing: string;
              python: { pythonPackages?: unknown[] };
              pythonMissing: string;
            }>(baseUrl, "formats");
            expect(out).toEqual({
              maven: {},
              mavenMissing: "NotFound",
              npm: {},
              npmMissing: "NotFound",
              python: {},
              pythonMissing: "NotFound",
            });
            // Imports are long-running: they start, then fail on the missing bucket.
            expect(yield* expectProbe(baseUrl, "imports")).toEqual({
              apt: "succeeded",
              yum: "succeeded",
              googet: "succeeded",
            });

            for (const repo of [formats.maven, formats.npm, formats.python]) {
              expect(yield* repositoryRoles(repo)).toEqual(["roles/artifactregistry.reader"]);
            }
            for (const repo of [formats.apt, formats.yum, formats.googet]) {
              expect(yield* repositoryRoles(repo)).toEqual(["roles/artifactregistry.writer"]);
            }
          }),
        live,
      );
    });
  },
);
