import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import { describe } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { waitForReady } from "../../Domain/conformance/conformance.ts";
import { latency } from "../../Domain/conformance/latency.ts";
import { Far, Near } from "./fixtures/latency-stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers()),
});

/**
 * How long a command takes on Cloudflare (see `latency.ts`), twice: with the
 * model's Durable Objects created near the caller, as they are by default,
 * and with all of them in Asia-Pacific, a continent away from a front that
 * still runs near the caller.
 */
describe.skipIf(!!process.env.FAST)(
  "Domain latency on Cloudflare",
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
  () => {
    const near = beforeAll(deploy(Near).pipe(Effect.tap(({ url }) => waitForReady(url))), {
      timeout: 1_500_000,
    });
    const far = beforeAll(deploy(Far).pipe(Effect.tap(({ url }) => waitForReady(url))), {
      timeout: 1_500_000,
    });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Near));
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Far));

    latency({
      kind: "live",
      test,
      label: "Cloudflare, objects near the front",
      url: Effect.map(near, ({ url }) => url),
    });
    latency({
      kind: "live",
      test,
      label: "Cloudflare, objects a continent from the front",
      url: Effect.map(far, ({ url }) => url),
    });
  },
);
