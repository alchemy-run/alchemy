import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import * as Provider from "@/Provider";
import { Stack } from "@/Stack";
import { State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { EnvBucket, RemoteContainer } from "./fixtures/remote/object.ts";
import RemoteContainerWorker from "./fixtures/remote/worker.ts";
import type { AsyncEchoObject } from "./fixtures/async/worker.ts";
import * as Result from "effect/Result";
const { test } = Test.make({ providers: Cloudflare.providers() });
// The testing API rejects flat create with ContainerCreateShapeUnsupported.
const liveLifecycle = test.provider.skipIf(
  process.env.CLOUDFLARE_TEST_CONTAINERS !== "1",
);

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

type Scratch = Parameters<Parameters<typeof test.provider>[1]>[0];

/** Give each application a real container-enabled namespace before creation. */
const attachedApplication = (id: string, image: string) =>
  Effect.gen(function* () {
    const container = Cloudflare.Container<AsyncEchoObject>(id, {
      image,
      className: "AsyncEchoObject",
    });
    const main = yield* Effect.sync(
      () => new URL("./fixtures/async/worker.ts", import.meta.url).pathname,
    );
    yield* Cloudflare.Worker(`${id}Worker`, {
      main,
      env: { ECHO: container },
    });
    return yield* container.Application;
  });

const deployImage = (scratch: Scratch, image: string) =>
  scratch.deploy(
    Effect.gen(function* () {
      return { app: yield* attachedApplication("DigestReuse", image) };
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
      times: 10,
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
  test.provider.skipIf(process.env.CLOUDFLARE_TEST_CONTAINERS === "1")(
    "flat create exposes the testing account's typed request-shape rejection",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const result = yield* deployImage(
          stack,
          "mendhak/http-https-echo:41",
        ).pipe(Effect.result);
        yield* stack.destroy();
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("ContainerCreateShapeUnsupported");
          expect(result.failure.message).toContain(
            'unrecognized key: \\"class_name\\"',
          );
        }
      }),
    { timeout: 120_000 },
  );
  // LIST carries the same public attributes as a resource read.
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

  // Pre-pushed tags and digests retain their original registry repository.
  liveLifecycle(
    "pre-pushed registry image is deployed as-is",
    (scratch) =>
      Effect.gen(function* () {
        yield* scratch.destroy();

        const source = yield* scratch.deploy(
          Effect.gen(function* () {
            return {
              app: yield* attachedApplication(
                "PrepushSource",
                "mendhak/http-https-echo:latest",
              ),
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
              app: yield* attachedApplication(
                "PrepushSource",
                "mendhak/http-https-echo:latest",
              ),
              byDigest: yield* attachedApplication(
                "PrepushByDigest",
                pushedRef,
              ),
              byTag: yield* attachedApplication("PrepushByTag", taggedRef),
            };
          }),
        );
        expect(all.byDigest.configuration.image).toBe(pushedRef);
        expect(all.byTag.configuration.image).toBe(pushedRef);

        yield* scratch.destroy();
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  // #1282: the image tag is `<repo>:<sourceHash>`, so any change to the
  // build inputs pushes a new tag — even when the resulting image is
  // byte-for-byte identical (a context file the Dockerfile never COPYs, a
  // lockfile, or here: the same remote image spelled with an explicit
  // registry host). The provider used to feed that new tag straight into
  // `updateContainerApplication`, minting a new application version and
  // rolling every instance for nothing. It now resolves the pushed manifest
  // digest and, when it matches the live image, skips the update entirely.
  liveLifecycle(
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
        const desiredImage = `${third.app.configuration.image!.split("@")[0]}@${third.app.hash!.digest}`;
        expect(third.app.hash?.digest).not.toBe(first.app.hash?.digest);
        const rolledOut = yield* waitForImage(
          accountId,
          first.app.applicationId,
          desiredImage,
        );
        expect(rolledOut.image).toBe(desiredImage);
        expect(rolledOut.version).toBeGreaterThan(first.app.version);

        yield* scratch.destroy();
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  // Legacy source hashes acquire a digest without rolling an unchanged image.
  liveLifecycle(
    "legacy state without a digest preserves an unchanged active image",
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
        yield* waitForImage(accountId, applicationId, taggedRef);

        // And the state row: tag reference, source hash only.
        yield* patchRow<typeof first.app>("DigestReuse", (attr) => ({
          ...attr,
          configuration: { ...attr.configuration, image: taggedRef },
          hash: { image: attr.hash!.image },
        }));

        // Compare the rebuilt digest with the observed historical tag.
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
            until: (app) => app.image === taggedRef,
            times: 10,
          }),
        );
        expect(after.image).toBe(taggedRef);

        // Source-hash changes alone do not require an update or rollout.
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
    { timeout: 120_000 },
  );

  // Recreate after an out-of-band delete without changing the Worker namespace.
  liveLifecycle(
    "out-of-band deletion recreates with the real Durable Object attachment",
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

        // Out-of-band deletion must recreate with the existing Worker namespace.
        yield* Containers.deleteContainerApplication({
          accountId,
          applicationId: first.app.applicationId,
        });
        yield* Containers.getContainerApplication({
          accountId,
          applicationId: first.app.applicationId,
        }).pipe(
          Effect.result,
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            times: 10,
            until: (result) =>
              Result.isFailure(result) &&
              result.failure._tag === "ContainerApplicationNotFound",
          }),
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(
                Result.isFailure(result) &&
                  result.failure._tag === "ContainerApplicationNotFound",
              ).toBe(true);
            }),
          ),
        );

        // Stale the persisted source hash so the re-create must rebuild.
        yield* patchRow<typeof first.app>("RemoteContainer", (attr) => ({
          ...attr,
          hash: { ...attr.hash!, image: "0000000000000000" },
        }));

        const second = yield* scratch.deploy(program);
        expect(second.app.applicationId).not.toBe(first.app.applicationId);
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
    { timeout: 120_000 },
  );
});
