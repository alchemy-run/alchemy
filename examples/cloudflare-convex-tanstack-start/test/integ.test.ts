import { expect } from "bun:test";
// test/integ.test.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Convex from "@alchemy.run/convex";
import * as Test from "@alchemy.run/test/Bun";
import * as management from "@distilled.cloud/convex/management";
import * as Alchemy from "alchemy";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Convex.providers()),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "the site serves and the Convex functions answer at the returned URL",
  Effect.gen(function* () {
    const { convexUrl, websiteUrl } = yield* stack;

    const page = yield* Test.getWhenReady(websiteUrl);
    expect(page.status).toBe(200);
    expect(yield* page.text).toContain("Convex on Cloudflare");

    const client = new ConvexHttpClient(convexUrl);
    yield* Effect.promise(() => client.mutation(anyApi.messages!.add!, { text: "hello" }));
    const rows = yield* Effect.promise(() => client.query(anyApi.messages!.list!, {}));
    expect(rows.map((row: { text: string }) => row.text)).toContain("hello");
  }),
  { timeout: 120_000 },
);

// `test.provider` runs with the stack's providers, which hold the Convex token.
test.provider("both keys exist on Convex", () =>
  Effect.gen(function* () {
    const { projectId, deploymentName, deployKeyName, previewKeyName } = yield* stack;

    const deployKeys = yield* management.listDeployKeys({ deploymentName });
    expect(deployKeys.map((key) => key.name)).toContain(deployKeyName);

    const previewKeys = yield* management.listPreviewDeployKeys({ projectId });
    expect(previewKeys.items.map((key) => key.name)).toContain(previewKeyName);
  }),
);
