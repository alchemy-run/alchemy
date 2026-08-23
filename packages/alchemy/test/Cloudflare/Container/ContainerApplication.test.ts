import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

describe("ContainerApplication", () => {
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
  // (e.g. a digest reference pushed by CI) is deployed as-is — no docker
  // pull/tag/push round-trip. The first deploy pushes a public image into the
  // account registry the normal way; the second deploy references the pushed
  // tag directly. The old (remote) path would have re-tagged it into a
  // repository named after the consumer app, so `configuration.image`
  // matching the original reference verbatim proves the as-is path ran.
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
        expect(pushedRef).toMatch(/^registry\.cloudflare\.com\//);

        const both = yield* scratch.deploy(
          Effect.gen(function* () {
            return {
              app: yield* Cloudflare.Container("PrepushSource", {
                image: "mendhak/http-https-echo:latest",
              }).Application,
              consumer: yield* Cloudflare.Container("PrepushConsumer", {
                image: pushedRef,
              }).Application,
            };
          }),
        );
        expect(both.consumer.configuration.image).toBe(pushedRef);

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

        const deployImage = (image: string) =>
          scratch.deploy(
            Effect.gen(function* () {
              return {
                app: yield* Cloudflare.Container("DigestReuse", { image })
                  .Application,
              };
            }),
          );
        const live = (applicationId: string) =>
          Containers.getContainerApplication({ accountId, applicationId }).pipe(
            Effect.map((app) => ({
              version: app.version,
              image: app.configuration.image,
            })),
          );

        const first = yield* deployImage("mendhak/http-https-echo:41");

        // Same image, different reference: the source hash changes and the
        // image is pulled + pushed again, but the registry digest does not.
        const second = yield* deployImage(
          "docker.io/mendhak/http-https-echo:41",
        );
        expect(second.app.applicationId).toBe(first.app.applicationId);
        expect(second.app.configuration.image).toBe(
          first.app.configuration.image,
        );
        expect(second.app.version).toBe(first.app.version);
        expect(yield* live(first.app.applicationId)).toEqual({
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
        const third = yield* deployImage("mendhak/http-https-echo:40");
        expect(third.app.applicationId).toBe(first.app.applicationId);
        expect(third.app.configuration.image).toMatch(
          /^registry\.cloudflare\.com\/.*@sha256:[a-f0-9]{64}$/,
        );
        expect(third.app.configuration.image).not.toBe(
          first.app.configuration.image,
        );
        const rolledOut = yield* live(first.app.applicationId).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (app) => app.image === third.app.configuration.image,
            times: 30,
          }),
        );
        expect(rolledOut.image).toBe(third.app.configuration.image);
        expect(rolledOut.version).toBeGreaterThan(first.app.version);

        yield* scratch.destroy();
      }).pipe(logLevel),
    { timeout: 900_000 },
  );
});
