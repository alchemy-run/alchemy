import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as aisearch from "@distilled.cloud/cloudflare/aisearch";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import AiSearchCrawlTargetWorker from "./fixtures/crawl-target-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getInstance = (accountId: string, id: string, namespace = "default") =>
  aisearch.readNamespaceInstance({ accountId, name: namespace, id }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const expectGone = (accountId: string, id: string, namespace = "default") =>
  getInstance(accountId, id, namespace).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "InstanceNotDeleted" } as const)),
    Effect.catchTag(
      ["AiSearchInstanceNotFound", "NamespaceNotFound"],
      () => Effect.void,
    ),
    Effect.retry({
      while: (e) => e._tag === "InstanceNotDeleted",
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );

// The `AiSearch` construct composes an R2 bucket, a managed service token
// (AccountApiToken + AiSearchToken children), and the instance — a single
// `yield*` wires the whole pipeline together.
const program = () =>
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2Bucket("AiSearchSource", {});
    const search = yield* Cloudflare.AiSearch("Search", {
      bucket,
    });
    return { bucket, search };
  });

test.provider(
  "construct auto-creates a managed token and wires it into the instance",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(program());

      const { instance, token } = deployed.search;
      expect(instance.instanceId).toBeTruthy();
      // The managed service token was minted as a child and wired in.
      expect(token).toBeDefined();
      expect(instance.tokenId).toEqual(token!.id);

      // Cloudflare's read projection hides the token association
      // (`tokenId` comes back `null`), so verify the instance exists rather
      // than re-asserting the token id off the read path.
      const live = yield* getInstance(accountId, instance.instanceId);
      expect(live.id).toEqual(instance.instanceId);

      yield* stack.destroy();

      yield* expectGone(accountId, instance.instanceId);
    }).pipe(logLevel),
  { timeout: 300_000 },
);

// A web-crawler source crawls a seed URL and needs no service token, so the
// construct must NOT mint an AccountApiToken / AiSearchToken — `token` comes
// back undefined. Cloudflare only crawls a domain the account owns, so the
// crawl is seeded at a Worker we deploy (its `workers.dev` URL is owned by the
// account); `parseType: "crawl"` walks pages instead of requiring a sitemap.
const crawlerProgram = () =>
  Effect.gen(function* () {
    const target = yield* AiSearchCrawlTargetWorker;
    const search = yield* Cloudflare.AiSearch("Search", {
      url: target.url.as<string>(),
      sourceParams: { webCrawler: { parseType: "crawl" } },
    });
    return { target, search };
  });

test.provider(
  "web-crawler source skips token minting",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(crawlerProgram());

      const { instance, token } = deployed.search;
      // No service token is minted for a web crawler.
      expect(token).toBeUndefined();
      expect(instance.type).toEqual("web-crawler");

      const live = yield* getInstance(accountId, instance.instanceId);
      expect(live.type).toEqual("web-crawler");

      yield* stack.destroy();

      yield* expectGone(accountId, instance.instanceId);
    }).pipe(logLevel),
  { timeout: 300_000 },
);
