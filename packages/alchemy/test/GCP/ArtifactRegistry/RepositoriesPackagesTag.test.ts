import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import { expect } from "alchemy-test";
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

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

const IMAGE = "hello";

const waitUntilGone = (name: string) =>
  artifactregistry.getProjectsLocationsRepositoriesPackagesTags({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitForVersion = (name: string) =>
  artifactregistry
    .getProjectsLocationsRepositoriesPackagesVersions({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("missing" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "found",
        times: 10,
      }),
    );

const sha256 = (bytes: Uint8Array) =>
  Effect.sync(
    () => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  );

const header = (
  response: HttpClientResponse.HttpClientResponse,
  name: string,
) => {
  const headers = response.headers as {
    get?: (key: string) => string | undefined;
  } & Record<string, string | undefined>;
  return (
    headers.get?.(name) ?? headers[name] ?? headers[name.toLowerCase()] ?? ""
  );
};

const failHttp = (
  label: string,
  response: HttpClientResponse.HttpClientResponse,
) =>
  Effect.gen(function* () {
    const body = yield* response.text.pipe(
      Effect.catch(() => Effect.succeed("")),
    );
    return yield* Effect.fail(
      new Error(`${label} failed: ${response.status} ${body}`),
    );
  });

const pushDockerVersion = (
  repository: {
    name: string;
    repositoryId: string;
    project: string;
    location: string;
  },
  marker: string,
) =>
  Effect.gen(function* () {
    const creds = yield* yield* Credentials;
    const client = yield* HttpClient.HttpClient;
    const token = Redacted.value(creds.accessToken);
    const host = `https://${repository.location}-docker.pkg.dev`;
    const imagePath = `${repository.project}/${repository.repositoryId}/${IMAGE}`;
    const auth = (request: HttpClientRequest.HttpClientRequest) =>
      request.pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
      );

    const config = yield* Effect.sync(() =>
      new TextEncoder().encode(
        JSON.stringify({
          architecture: "amd64",
          os: "linux",
          rootfs: { type: "layers", diff_ids: [] },
          config: { Env: [`MARKER=${marker}`] },
        }),
      ),
    );
    const configDigest = yield* sha256(config);

    const start = yield* client.execute(
      auth(HttpClientRequest.post(`${host}/v2/${imagePath}/blobs/uploads/`)),
    );
    if (start.status !== 202) {
      return yield* failHttp("blob upload start", start);
    }
    let location = header(start, "location");
    if (location.startsWith("/")) location = `${host}${location}`;
    const sep = location.includes("?") ? "&" : "?";
    const uploaded = yield* client.execute(
      auth(
        HttpClientRequest.put(`${location}${sep}digest=${configDigest}`).pipe(
          HttpClientRequest.bodyUint8Array(config, "application/octet-stream"),
        ),
      ),
    );
    if (uploaded.status < 200 || uploaded.status >= 300) {
      return yield* failHttp("blob upload", uploaded);
    }

    const manifest = yield* Effect.sync(() =>
      new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 2,
          mediaType: "application/vnd.docker.distribution.manifest.v2+json",
          config: {
            mediaType: "application/vnd.docker.container.image.v1+json",
            size: config.byteLength,
            digest: configDigest,
          },
          layers: [],
        }),
      ),
    );
    const manifestDigest = yield* sha256(manifest);
    const published = yield* client.execute(
      auth(
        HttpClientRequest.put(
          `${host}/v2/${imagePath}/manifests/${marker}`,
        ).pipe(
          HttpClientRequest.bodyUint8Array(
            manifest,
            "application/vnd.docker.distribution.manifest.v2+json",
          ),
        ),
      ),
    );
    if (published.status < 200 || published.status >= 300) {
      return yield* failHttp("manifest put", published);
    }

    return `${repository.name}/packages/${IMAGE}/versions/${manifestDigest}`;
  }).pipe(
    Effect.retry({
      times: 5,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a package tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const repo = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ArtifactRegistry.Repository("Images", {
            location: "us-central1",
            format: "DOCKER",
            description: "tag parent",
          });
        }),
      );

      const v1 = yield* pushDockerVersion(repo, "v1");
      const v2 = yield* pushDockerVersion(repo, "v2");
      expect(yield* waitForVersion(v1)).toEqual("found");
      expect(yield* waitForVersion(v2)).toEqual("found");

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const images = yield* GCP.ArtifactRegistry.Repository("Images", {
            repositoryId: repo.repositoryId,
            location: "us-central1",
            format: "DOCKER",
            description: "tag parent",
          });
          const tag = yield* GCP.ArtifactRegistry.RepositoriesPackagesTag(
            "Stable",
            {
              repository: images.name,
              packageId: IMAGE,
              tagId: "stable",
              version: v1,
            },
          );
          return { images, tag };
        }),
      );

      expect(created.tag.name).toContain("/tags/");
      expect(created.tag.tagId).toEqual("stable");
      expect(created.tag.packageId).toEqual(IMAGE);
      expect(created.tag.version).toEqual(v1);

      const fetched =
        yield* artifactregistry.getProjectsLocationsRepositoriesPackagesTags({
          name: created.tag.name,
        });
      expect(fetched.name).toEqual(created.tag.name);
      expect(fetched.version).toEqual(v1);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const images = yield* GCP.ArtifactRegistry.Repository("Images", {
            repositoryId: repo.repositoryId,
            location: "us-central1",
            format: "DOCKER",
            description: "tag parent",
          });
          const tag = yield* GCP.ArtifactRegistry.RepositoriesPackagesTag(
            "Stable",
            {
              repository: images.name,
              packageId: IMAGE,
              tagId: "stable",
              version: v2,
            },
          );
          return { images, tag };
        }),
      );

      expect(updated.tag.name).toEqual(created.tag.name);
      expect(updated.tag.version).toEqual(v2);

      const refetched =
        yield* artifactregistry.getProjectsLocationsRepositoriesPackagesTags({
          name: created.tag.name,
        });
      expect(refetched.version).toEqual(v2);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.tag.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
