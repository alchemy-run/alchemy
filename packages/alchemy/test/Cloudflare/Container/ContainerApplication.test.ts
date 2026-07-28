import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
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
});
