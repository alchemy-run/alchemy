import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:intel", "live"];

// Creating a feed needs a Cloudforce One feed-provider account
// (`IndicatorFeedsNotEntitled`, pinned in IndicatorFeed.test.ts); reading
// feeds works on any account. Set CLOUDFLARE_TEST_INTEL_FEEDS=1 on an
// entitled account. Feeds can't be deleted, so the suites share one.
const entitled = !!process.env.CLOUDFLARE_TEST_INTEL_FEEDS;
const FEED_NAME = "alchemy-intel-test-feed";

const callerScript = `export default {
  async fetch() {
    return new Response("ok");
  },
};`;

const TargetStack = Alchemy.Stack(
  "IntelIndicatorFeedLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const feed = yield* Cloudflare.Intel.IndicatorFeed("lookup-target", { name: FEED_NAME });
    return { feedId: feed.feedId.as<number>() };
  }),
);

const target = beforeAll(entitled ? deploy(TargetStack) : Effect.succeed({ feedId: 0 }));
afterAll.skipIf(!entitled || !!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider.skipIf(!entitled)(
  "a looked-up feed resolves by id and by name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { feedId } = yield* target;

      const program = Effect.gen(function* () {
        const byName = Cloudflare.Intel.IndicatorFeed.lookup({ name: FEED_NAME });
        const byId = Cloudflare.Intel.IndicatorFeed.lookup({ feedId });
        yield* Cloudflare.Worker("feed-lookup-caller", {
          script: callerScript,
          env: { FEED: byName.name },
        });
        return { byNameId: byName.feedId, byIdName: byId.name };
      });
      const out = yield* stack.deploy(program);
      expect(out.byNameId).toBe(feedId);
      expect(out.byIdName).toBe(FEED_NAME);

      const plan = yield* stack.plan(program);
      expect(plan.resources["feed-lookup-caller"].action).toBe("noop");

      yield* stack.destroy();
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing feed fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("feed-lookup-missing", {
            script: callerScript,
            env: { FEED: Cloudflare.Intel.IndicatorFeed.lookup({ name }).name },
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
