import * as Cloudflare from "@alchemy.run/cloudflare";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import { describe } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { conformance, rebuild, waitForReady } from "../../Domain/conformance/conformance.ts";
import Stack, { StackV1 } from "./fixtures/conformance-stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers()),
});

// The Domain conformance suite, with the model on Cloudflare Durable Objects.
describe("Domain on Cloudflare", { tags: ["provider:cloudflare", "live"] }, () => {
  const stack = beforeAll(deploy(Stack).pipe(Effect.tap(({ url }) => waitForReady(url))), {
    timeout: 300_000,
  });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

  conformance({ test, url: Effect.map(stack, ({ url }) => url), kind: "live" });
  // Last: it redeploys the front.
  rebuild({
    test,
    url: Effect.map(stack, ({ url }) => url),
    kind: "live",
    deploy: (version) =>
      deploy(version === 0 ? Stack : StackV1).pipe(Effect.flatMap(({ url }) => waitForReady(url))),
  });
});
