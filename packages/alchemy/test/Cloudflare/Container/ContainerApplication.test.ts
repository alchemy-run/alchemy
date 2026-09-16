import * as Cloudflare from "@/Cloudflare";
import * as Drift from "@/Drift.ts";
import { Docker, DockerLive } from "@/Docker/Docker.ts";
import * as Layer from "effect/Layer";
import * as Config from "effect/Config";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { ExternalContainer } from "./fixtures/external/object.ts";
import ExternalContainerWorker from "./fixtures/external/worker.ts";
import MyContainerLive, {
  MyContainer,
} from "./fixtures/effectful/container.ts";
import EffectfulContainerWorker from "./fixtures/effectful/worker.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import * as Provider from "@/Provider";
import { Stack } from "@/Stack";
import { State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import { assert, describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { applications } from "./fixtures/identity/applications.ts";
import { EnvBucket, RemoteContainer } from "./fixtures/remote/object.ts";
import RemoteContainerWorker from "./fixtures/remote/worker.ts";
const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), DockerLive),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

type Scratch = Parameters<Parameters<typeof test.provider>[1]>[0];

/** Deploy a standalone container application from a remote `image`. */
const deployImage = (scratch: Scratch, image: string) =>
  scratch.deploy(
    Effect.gen(function* () {
      return {
        app: yield* Cloudflare.Container("DigestReuse", { image }).Application,
      };
    }),
  );

/** The live (active) image reference + version of an application. */
const live = (accountId: string, applicationId: string) =>
  Containers.getContainerApplication({ accountId, applicationId }).pipe(
    Effect.map((app) => ({
      version: app.version,
      image: app.configuration.image,
      durableObjects: app.durableObjects ?? undefined,
    })),
  );

/**
 * Poll until the application's active image is `image`. Cloudflare reports
 * the ACTIVE configuration (and version) until a rollout completes, so any
 * assertion on a changed image has to wait for the rollout.
 */
const waitForImage = (
  accountId: string,
  applicationId: string,
  image: string,
) =>
  live(accountId, applicationId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (app) => app.image === image,
      times: 30,
    }),
  );

/** `<repo>:<sourceHash>` — the mutable tag the provider pushed `app` as. */
const taggedRefOf = (app: {
  configuration: { image?: string };
  hash?: { image: string };
}) => {
  const digestRef = app.configuration.image!;
  return `${digestRef.slice(0, digestRef.indexOf("@"))}:${app.hash!.image}`;
};

/** Rewrite the persisted attributes of the scratch row for `fqn`. */
const patchRow = <A extends Record<string, any>>(
  fqn: string,
  patch: (attr: A) => A,
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const stk = yield* Stack;
    const key = { stack: stk.name, stage: stk.stage, fqn };
    const row = (yield* state.get(key)) as ResourceState;
    yield* state.set({
      ...key,
      value: { ...row, attr: patch(row.attr as A) },
    });
  });

describe("ContainerApplication", () => {
  for (const fixture of [
    {
      name: "Dockerfile",
      program: Effect.gen(function* () {
        const worker = yield* ExternalContainerWorker;
        const app: Cloudflare.ContainerApplication =
          yield* ExternalContainer.Application;
        return { app, url: worker.url.as<string>() };
      }),
      route: "/hello",
      response: "hello from external container",
    },
    {
      name: "generated",
      program: Effect.gen(function* () {
        const worker = yield* EffectfulContainerWorker;
        const app: Cloudflare.ContainerApplication =
          yield* MyContainer.Application;
        return { app, url: worker.url.as<string>() };
      }).pipe(Effect.provide(MyContainerLive)),
      route: "/ping",
      response: "pong",
    },
  ]) {
    test.provider(
      `exports ${fixture.name} builds from a non-loading builder to the registry`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const docker = yield* Docker;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const configDir = yield* Config.String("DOCKER_CONFIG").pipe(
            Config.orElse(() =>
              Config.String("HOME").pipe(
                Config.map((home) => path.join(home, ".docker")),
              ),
            ),
          );
          const configFile = path.join(configDir, "config.json");
          const readConfig = fs
            .readFileString(configFile)
            .pipe(
              Effect.catchReason("PlatformError", "NotFound", () =>
                Effect.succeed(undefined),
              ),
            );
          const configBefore = yield* readConfig;
          const builder = `alchemy-registry-export-${fixture.name.toLowerCase()}`;
          yield* Effect.acquireRelease(
            docker.run([
              "buildx",
              "create",
              "--name",
              builder,
              "--driver",
              "docker-container",
            ]),
            () =>
              docker
                .run(["buildx", "rm", "--force", builder])
                .pipe(Effect.orDie),
          );
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const previous = {
                builder: process.env.BUILDX_BUILDER,
                attestations: process.env.BUILDX_NO_DEFAULT_ATTESTATIONS,
              };
              process.env.BUILDX_BUILDER = builder;
              process.env.BUILDX_NO_DEFAULT_ATTESTATIONS = "false";
              return previous;
            }),
            (previous) =>
              Effect.sync(() => {
                if (previous.builder === undefined)
                  delete process.env.BUILDX_BUILDER;
                else process.env.BUILDX_BUILDER = previous.builder;
                if (previous.attestations === undefined)
                  delete process.env.BUILDX_NO_DEFAULT_ATTESTATIONS;
                else
                  process.env.BUILDX_NO_DEFAULT_ATTESTATIONS =
                    previous.attestations;
              }),
          );
          const selected = yield* docker.run(["buildx", "inspect"]);
          expect(selected.stdout).toMatch(/Driver:\s+docker-container/);
          expect(selected.stdout).toContain(builder);

          const deployed = yield* stack.deploy(fixture.program);
          const tag = taggedRefOf(deployed.app);
          const local = yield* docker.image
            .inspect(tag)
            .pipe(
              Effect.catchReason("PlatformError", "NotFound", () =>
                Effect.succeed(undefined),
              ),
            );
          expect(local).toBeUndefined();
          expect(deployed.app.hash?.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

          const { accountId, applicationId } = deployed.app;
          const credentials =
            yield* Containers.createContainerRegistryCredentials({
              accountId,
              registryId: "registry.cloudflare.com",
              permissions: ["pull"],
              expirationMinutes: 15,
            });
          const username = credentials.username ?? credentials.user;
          assert(username);
          const client = yield* HttpClient.HttpClient;
          const repository = tag.slice(
            "registry.cloudflare.com/".length,
            tag.lastIndexOf(":"),
          );
          const manifest = yield* client.execute(
            HttpClientRequest.get(
              `https://registry.cloudflare.com/v2/${repository}/manifests/${deployed.app.hash!.digest}`,
            ).pipe(
              HttpClientRequest.basicAuth(username, credentials.password),
              HttpClientRequest.setHeader(
                "Accept",
                "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
              ),
            ),
          );
          expect(manifest.status).toBe(200);
          expect(manifest.headers["docker-content-digest"]).toBe(
            deployed.app.hash!.digest,
          );
          const index = yield* manifest.json.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  mediaType: Schema.String,
                  manifests: Schema.Array(
                    Schema.Struct({
                      platform: Schema.Struct({
                        os: Schema.String,
                        architecture: Schema.String,
                      }),
                    }),
                  ),
                }),
              ),
            ),
          );
          expect(index.mediaType).toBe(
            "application/vnd.oci.image.index.v1+json",
          );
          expect(
            index.manifests.some(
              ({ platform }) =>
                platform.os === "linux" && platform.architecture === "amd64",
            ),
          ).toBe(true);
          const observed = yield* Containers.getContainerApplication({
            accountId,
            applicationId,
          });
          expect(observed.configuration.image).toBe(
            deployed.app.configuration.image,
          );

          const response = yield* Effect.gen(function* () {
            const response = yield* client.get(
              `${deployed.url}${fixture.route}`,
            );
            return { status: response.status, body: yield* response.text };
          }).pipe(
            Effect.timeout("45 seconds"),
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (response) =>
                response.status === 200 &&
                response.body.includes(fixture.response),
              times: 8,
            }),
          );
          expect(response.status).toBe(200);
          expect(response.body).toContain(fixture.response);
          expect(yield* readConfig).toBe(configBefore);
          const unchanged = yield* stack.deploy(fixture.program);
          expect(unchanged.app.applicationId).toBe(applicationId);
          expect(unchanged.app.hash).toEqual(deployed.app.hash);

          yield* stack.destroy();
          const deleted = yield* Containers.getContainerApplication({
            accountId,
            applicationId,
          }).pipe(
            Effect.catchTag("ContainerApplicationNotFound", () =>
              Effect.succeed(undefined),
            ),
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (app) => app === undefined,
              times: 8,
            }),
          );
          expect(deleted).toBeUndefined();
        }).pipe(logLevel, Effect.scoped),
      { timeout: 120_000, exclusive: true },
    );
  }

  for (const maxInstances of [2, 4]) {
    for (const field of [
      "applicationId",
      "applicationName",
      "accountId",
    ] as const) {
      test.provider(
        `plans replacement for cached ${field} mismatches with ${maxInstances === 2 ? "unchanged" : "changed"} props`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();

            const first = yield* stack.deploy(applications());
            const { accountId } = first.owned;
            const observed = yield* Effect.forEach(
              [first.owned, first.other],
              (app) =>
                Containers.getContainerApplication({
                  accountId,
                  applicationId: app.applicationId,
                }),
            );
            const state = yield* yield* State;
            const key = {
              stack: stack.name,
              stage: stack.stage,
              fqn: "CachedIdentity",
            };
            const row = yield* state.get(key);
            assert(row?.status === "created" || row?.status === "updated");

            yield* Effect.gen(function* () {
              const inconsistent = {
                ...row,
                attr: {
                  ...row.attr,
                  [field]:
                    field === "accountId"
                      ? "00000000000000000000000000000000"
                      : first.other[field],
                },
              };
              yield* state.set({ ...key, value: inconsistent });

              const plan = yield* stack.plan(applications(maxInstances));
              expect(plan.resources.CachedIdentity.action).toBe("replace");
              expect(plan.resources.CachedIdentity.state).toEqual(inconsistent);
              expect(plan.resources.OtherIdentity.action).toBe("noop");
              expect(yield* state.get(key)).toEqual(inconsistent);

              for (const before of observed) {
                const after = yield* Containers.getContainerApplication({
                  accountId,
                  applicationId: before.id,
                });
                expect(after).toMatchObject({
                  id: before.id,
                  name: before.name,
                  version: before.version,
                  maxInstances: before.maxInstances,
                  configuration: before.configuration,
                });
              }
            }).pipe(
              // Restore the real identity before teardown, even on failure.
              Effect.ensuring(
                state.set({ ...key, value: row }).pipe(Effect.orDie),
              ),
            );

            const checked = yield* Drift.detect(stack);
            expect(checked.resources.CachedIdentity.attr).toMatchObject({
              applicationId: first.owned.applicationId,
              applicationName: first.owned.applicationName,
              accountId,
            });
            const recovered = yield* stack.deploy(applications());
            expect(recovered.owned.applicationId).toBe(
              first.owned.applicationId,
            );
            expect(recovered.other.applicationId).toBe(
              first.other.applicationId,
            );

            yield* stack.destroy();
            for (const app of [first.owned, first.other]) {
              const deleted = yield* Containers.getContainerApplication({
                accountId,
                applicationId: app.applicationId,
              }).pipe(
                Effect.catchTag("ContainerApplicationNotFound", () =>
                  Effect.succeed(undefined),
                ),
                Effect.repeat({
                  schedule: Schedule.spaced("1 second"),
                  until: (app) => app === undefined,
                  times: 8,
                }),
              );
              expect(deleted).toBeUndefined();
            }
          }).pipe(logLevel),
        { timeout: 120_000 },
      );
    }
  }

  test.provider(
    "replaces the fixture when its configured name changes",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const first = yield* stack.deploy(applications());
        const name = `renamed-${first.owned.applicationName.slice(-24)}`;
        const renamed = applications(2, name);

        const scaling = yield* stack.plan(applications(4));
        expect(scaling.resources.CachedIdentity.action).toBe("update");
        const plan = yield* stack.plan(renamed);
        expect(plan.resources.CachedIdentity.action).toBe("replace");
        expect(plan.resources.OtherIdentity.action).toBe("noop");
        const before = yield* Containers.getContainerApplication({
          accountId: first.owned.accountId,
          applicationId: first.owned.applicationId,
        });
        expect(before.name).toBe(first.owned.applicationName);
        expect(before.maxInstances).toBe(2);

        const second = yield* stack.deploy(renamed);
        expect(second.owned.applicationName).toBe(name);
        expect(second.owned.applicationId).not.toBe(first.owned.applicationId);
        expect(second.other.applicationId).toBe(first.other.applicationId);
        const observed = yield* Containers.getContainerApplication({
          accountId: second.owned.accountId,
          applicationId: second.owned.applicationId,
        });
        expect(observed.name).toBe(name);

        yield* stack.destroy();
        for (const app of [first.owned, second.owned, second.other]) {
          const deleted = yield* Containers.getContainerApplication({
            accountId: app.accountId,
            applicationId: app.applicationId,
          }).pipe(
            Effect.catchTag("ContainerApplicationNotFound", () =>
              Effect.succeed(undefined),
            ),
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (app) => app === undefined,
              times: 8,
            }),
          );
          expect(deleted).toBeUndefined();
        }
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  test.provider(
    "forwards the fixture's memoryMib to Cloudflare",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const app = yield* stack.deploy(RemoteContainer.Application);
        expect(app.configuration.memoryMib).toBe(4096);
        const live = yield* Containers.getContainerApplication({
          accountId: app.accountId,
          applicationId: app.applicationId,
        });
        expect(live.configuration.memoryMib).toBe(4096);
        expect(live.configuration.instanceType).not.toBe("lite");

        yield* stack.destroy();
        const deleted = yield* Containers.getContainerApplication({
          accountId: app.accountId,
          applicationId: app.applicationId,
        }).pipe(
          Effect.catchTag("ContainerApplicationNotFound", () =>
            Effect.succeed(undefined),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (app) => app === undefined,
            times: 8,
          }),
        );
        expect(deleted).toBeUndefined();
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  // Canonical `list()` test (Cloudflare account collection, pattern (b)).
  // `listContainerApplications` returns the full application objects in one
  // (non-paginated) response, so `list()` maps each into the exact `read`
  // Attributes shape. Deploying a real container application requires a Docker
  // build + push to the Cloudflare registry (not feasible in this harness), so
  // this is a read-only enumeration assertion: the result is a well-typed array
  // (possibly empty on an account with no container applications) and every
  // element carries the full Attributes shape.
  test.provider("list enumerates container applications", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(Cloudflare.Container);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const app of all) {
        expect(typeof app.applicationId).toBe("string");
        expect(typeof app.applicationName).toBe("string");
        expect(typeof app.accountId).toBe("string");
        expect(app.configuration).toBeDefined();
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  );

  // Issue #953 (2): an `image` that already references the target registry
  // (e.g. pushed by CI) is deployed as-is — no docker pull/tag/push
  // round-trip. The first deploy pushes a public image into the account
  // registry the normal way; the second deploy references it directly, both
  // by digest and by tag. The old (remote) path would have re-tagged it into
  // a repository named after the consumer app, so `configuration.image`
  // landing on the source's digest reference proves the as-is path ran.
  //
  // The tag consumer is the only place `resolveRegistryDigest` (the
  // `HEAD /v2/<repo>/manifests/<tag>` probe against Cloudflare's registry)
  // runs on the happy path — a digest reference short-circuits it and a
  // local push reads the digest from `docker push` output.
  test.provider(
    "pre-pushed registry image is deployed as-is",
    (scratch) =>
      Effect.gen(function* () {
        yield* scratch.destroy();

        const source = yield* scratch.deploy(
          Effect.gen(function* () {
            return {
              app: yield* Cloudflare.Container("PrepushSource", {
                image: "mendhak/http-https-echo:latest",
              }).Application,
            };
          }),
        );
        const pushedRef = source.app.configuration.image!;
        expect(pushedRef).toMatch(
          /^registry\.cloudflare\.com\/.*@sha256:[a-f0-9]{64}$/,
        );
        // The mutable tag the provider pushed: `<repo>:<sourceHash>`.
        const taggedRef = `${pushedRef.slice(0, pushedRef.indexOf("@"))}:${source.app.hash!.image}`;

        const all = yield* scratch.deploy(
          Effect.gen(function* () {
            return {
              app: yield* Cloudflare.Container("PrepushSource", {
                image: "mendhak/http-https-echo:latest",
              }).Application,
              byDigest: yield* Cloudflare.Container("PrepushByDigest", {
                image: pushedRef,
              }).Application,
              byTag: yield* Cloudflare.Container("PrepushByTag", {
                image: taggedRef,
              }).Application,
            };
          }),
        );
        expect(all.byDigest.configuration.image).toBe(pushedRef);
        expect(all.byTag.configuration.image).toBe(pushedRef);

        yield* scratch.destroy();
      }).pipe(logLevel),
    { timeout: 600_000 },
  );

  // #1282: the image tag is `<repo>:<sourceHash>`, so any change to the
  // build inputs pushes a new tag — even when the resulting image is
  // byte-for-byte identical (a context file the Dockerfile never COPYs, a
  // lockfile, or here: the same remote image spelled with an explicit
  // registry host). The provider used to feed that new tag straight into
  // `updateContainerApplication`, minting a new application version and
  // rolling every instance for nothing. It now resolves the pushed manifest
  // digest and, when it matches the live image, skips the update entirely.
  test.provider(
    "re-pushing an identical image does not create a new application version",
    (scratch) =>
      Effect.gen(function* () {
        yield* scratch.destroy();
        const { accountId } = yield* yield* CloudflareEnvironment;

        const first = yield* deployImage(scratch, "mendhak/http-https-echo:41");

        // Same image, different reference: the source hash changes and the
        // image is pulled + pushed again, but the registry digest does not.
        const second = yield* deployImage(
          scratch,
          "docker.io/mendhak/http-https-echo:41",
        );
        expect(second.app.applicationId).toBe(first.app.applicationId);
        expect(second.app.configuration.image).toBe(
          first.app.configuration.image,
        );
        expect(second.app.version).toBe(first.app.version);
        expect(yield* live(accountId, first.app.applicationId)).toMatchObject({
          version: first.app.version,
          image: first.app.configuration.image,
        });
        // The live reference is the immutable digest, not the mutable tag.
        expect(first.app.configuration.image).toMatch(
          /^registry\.cloudflare\.com\/.*@sha256:[a-f0-9]{64}$/,
        );

        // A genuinely different image still updates and rolls out. The API
        // reports the ACTIVE configuration (and version) until the rollout
        // completes, so poll until the new digest is live.
        const third = yield* deployImage(scratch, "mendhak/http-https-echo:40");
        expect(third.app.applicationId).toBe(first.app.applicationId);
        expect(third.app.configuration.image).toMatch(
          /^registry\.cloudflare\.com\/.*@sha256:[a-f0-9]{64}$/,
        );
        expect(third.app.configuration.image).not.toBe(
          first.app.configuration.image,
        );
        const rolledOut = yield* waitForImage(
          accountId,
          first.app.applicationId,
          third.app.configuration.image!,
        );
        expect(rolledOut.image).toBe(third.app.configuration.image);
        expect(rolledOut.version).toBeGreaterThan(first.app.version);

        yield* scratch.destroy();
      }).pipe(logLevel),
    { timeout: 900_000 },
  );

  // State written before #1282 carries only `hash.image`, and its live
  // application runs the mutable `<repo>:<sourceHash>` tag. On the first
  // reconcile after upgrading, the provider resolves that tag's digest
  // through the registry, keeps the live tag reference when the rebuilt
  // image matches, and persists the digest + configuration fingerprint
  // through one normal update. Every later source-hash drift is then a noop.
  test.provider(
    "legacy state without a digest migrates through one update",
    (scratch) =>
      Effect.gen(function* () {
        yield* scratch.destroy();
        const { accountId } = yield* yield* CloudflareEnvironment;

        const first = yield* deployImage(scratch, "mendhak/http-https-echo:41");
        const { applicationId } = first.app;
        const taggedRef = taggedRefOf(first.app);

        // Put the cloud where a pre-digest engine left it: the mutable tag
        // is the ACTIVE image (update + rollout, then wait for it to land).
        const legacyConfiguration = {
          ...first.app.configuration,
          image: taggedRef,
        };
        yield* Containers.updateContainerApplication({
          accountId,
          applicationId,
          configuration: legacyConfiguration,
        });
        yield* Containers.createContainerApplicationRollout({
          accountId,
          applicationId,
          description: "legacy tag reference",
          strategy: "rolling",
          kind: "full_auto",
          stepPercentage: 100,
          targetConfiguration: legacyConfiguration,
        });
        const legacy = yield* waitForImage(accountId, applicationId, taggedRef);

        // And the state row: tag reference, source hash only.
        yield* patchRow<typeof first.app>("DigestReuse", (attr) => ({
          ...attr,
          configuration: { ...attr.configuration, image: taggedRef },
          hash: { image: attr.hash!.image },
        }));

        // Source-hash drift on the migrated row: the rebuilt digest is
        // compared against the live tag's digest (resolved via the
        // registry), the live reference is kept, and the digest +
        // fingerprint are persisted through one update. That update still
        // carries one rollout — the live configuration is Cloudflare-
        // enriched, so the pre-fingerprint `deepEqual` misses — which is
        // exactly what the fingerprint prevents from here on.
        const migrated = yield* deployImage(
          scratch,
          "docker.io/mendhak/http-https-echo:41",
        );
        expect(migrated.app.applicationId).toBe(applicationId);
        expect(migrated.app.configuration.image).toBe(taggedRef);
        expect(migrated.app.hash?.digest).toBe(first.app.hash?.digest);
        expect(migrated.app.hash?.configuration).toBeDefined();
        const after = yield* live(accountId, applicationId).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (app) => app.version > legacy.version,
            times: 30,
          }),
        );
        expect(after.image).toBe(taggedRef);

        // From here on, drift is free: no update, no rollout.
        const settled = yield* deployImage(
          scratch,
          "mendhak/http-https-echo:41",
        );
        expect(settled.app.configuration.image).toBe(taggedRef);
        expect(settled.app.hash?.image).not.toBe(migrated.app.hash?.image);
        yield* Effect.sleep("10 seconds");
        expect(yield* live(accountId, applicationId)).toMatchObject({
          image: taggedRef,
          version: after.version,
        });

        yield* scratch.destroy();
      }).pipe(logLevel),
    { timeout: 900_000 },
  );

  // The Durable Object attachment is immutable, so a reconcile that finds an
  // application without it (precreate's stub, or a deploy that died between
  // precreate and reconcile) deletes and re-creates the application. When
  // the source hash has drifted in between, that path rebuilds the image and
  // must apply the same digest comparison as a plain update.
  test.provider(
    "re-creating an application to attach its Durable Object reuses an unchanged digest",
    (scratch) =>
      Effect.gen(function* () {
        yield* scratch.destroy();
        const { accountId } = yield* yield* CloudflareEnvironment;

        const program = Effect.gen(function* () {
          yield* EnvBucket;
          const worker = yield* RemoteContainerWorker;
          const app = yield* RemoteContainer.Application;
          return { url: worker.url.as<string>(), app };
        });

        const first = yield* scratch.deploy(program);
        const namespaceId = first.app.durableObjects?.namespaceId;
        expect(namespaceId).toBeDefined();
        const digestRef = first.app.configuration.image!;

        // Out-of-band, leave the cloud the way precreate does: same name and
        // configuration, no Durable Object attachment.
        yield* Containers.deleteContainerApplication({
          accountId,
          applicationId: first.app.applicationId,
        });
        yield* Containers.listContainerApplications({ accountId }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (apps) =>
              apps.every((app) => app.id !== first.app.applicationId),
            times: 30,
          }),
        );
        const detached = yield* Containers.createContainerApplication({
          accountId,
          name: first.app.applicationName,
          maxInstances: first.app.maxInstances,
          instances: first.app.instances,
          schedulingPolicy: first.app.schedulingPolicy,
          constraints: first.app.constraints,
          affinities: first.app.affinities,
          configuration: first.app.configuration,
        });
        expect(detached.durableObjects ?? undefined).toBeUndefined();

        // Stale the persisted source hash so the re-create must rebuild.
        yield* patchRow<typeof first.app>("RemoteContainer", (attr) => ({
          ...attr,
          hash: { ...attr.hash!, image: "0000000000000000" },
        }));

        const second = yield* scratch.deploy(program);
        expect(second.app.applicationId).not.toBe(detached.id);
        expect(second.app.durableObjects?.namespaceId).toBe(namespaceId);
        expect(second.app.configuration.image).toBe(digestRef);
        expect(second.app.hash?.digest).toBe(first.app.hash?.digest);
        expect(second.app.hash?.image).not.toBe("0000000000000000");
        expect(yield* live(accountId, second.app.applicationId)).toMatchObject({
          image: digestRef,
          durableObjects: { namespaceId },
        });

        yield* scratch.destroy();
      }).pipe(logLevel),
    { timeout: 900_000 },
  );
});
