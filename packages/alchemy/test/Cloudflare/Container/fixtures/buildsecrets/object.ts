import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import * as Cloudflare from "@/Cloudflare";

export const BUILD_SECRET = "alchemy-build-secret-value";

export class BuildSecretsContainer extends Cloudflare.Container<BuildSecretsContainer>()(
  "BuildSecretsContainer",
  {
    // A template string, not `path.join(import.meta.dirname, …)`: this module
    // is bundled into the Worker, where `import.meta.dirname` is undefined.
    context: `${import.meta.dirname}/context`,
    buildArgs: { GREETING: "hello" },
    buildSecrets: { token: Redacted.make(BUILD_SECRET) },
  },
) {}

/**
 * Durable Object that starts {@link BuildSecretsContainer} and returns
 * the page its build wrote.
 */
export class BuildSecretsObject extends Cloudflare.DurableObject<BuildSecretsObject>()(
  "BuildSecretsObject",
  Effect.gen(function* () {
    const container = yield* BuildSecretsContainer;

    return Effect.gen(function* () {
      const start = container.start({ enableInternet: true });
      const { fetch } = yield* container.getTcpPort(8080);

      return {
        page: () =>
          Effect.gen(function* () {
            yield* start;
            const response = yield* fetch(HttpClientRequest.get("http://container/"));
            return yield* response.text;
          }),
      };
    });
  }),
) {}
