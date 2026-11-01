import { expect } from "@alchemy.run/test";
import * as cdn from "@distilled.cloud/stackit/cdn";
import * as functions from "@distilled.cloud/stackit/functions";
import * as objectStorage from "@distilled.cloud/stackit/object_storage";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { expectFunctionGone } from "../Functions/helpers.ts";
import { logLevel, stackitTags } from "../helpers.ts";

/**
 * Shared helpers of the `Stackit.Website.*` live suites. Each test deploys a
 * framework fixture, shared with the AWS and Cloudflare website suites, drives it
 * over HTTP through the CDN and verifies the CDN and the function out-of-band.
 *
 * A server-rendered site runs on Functions, an alpha API, and pushes an image, so
 * those suites use the Functions gates (`noBuiltFunctions`). An assets-only site
 * needs only a bucket and the CDN: under EUR 0.01 per run, ungated.
 */
export { logLevel };

export const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

export const awsFixture = (name: string) =>
  pathe.resolve(import.meta.dirname, "../../AWS/Website/fixtures", name);

export const cloudflareFixture = (name: string) =>
  pathe.resolve(import.meta.dirname, "../../Cloudflare/Website", name);

export const exampleDir = (name: string) =>
  pathe.resolve(import.meta.dirname, "../../../../../examples", name);

/** Image build + push + revision rollout + CDN create + destroy. */
export const liveOptions = (timeout = 1_500_000) => ({
  timeout,
  retry: 0,
  tags: stackitTags("website"),
});

/** The parts of a deployed site that identify it out-of-band. */
export interface DeployedSite {
  readonly url: string;
  readonly projectId: string;
  readonly distributionId: string;
  readonly hostname: string;
}

const observeDistribution = (site: DeployedSite) =>
  cdn
    .getDistribution({ projectId: site.projectId, distributionId: site.distributionId })
    .pipe(Effect.map((response) => response.distribution));

/** The response comes from the CDN's hostname, whose origin is the expected backend. */
export const expectThroughCdn = Effect.fn(function* (
  site: DeployedSite,
  expected: { type: "bucket" } | { type: "http"; originUrl: string },
) {
  expect(site.url).toEqual(`https://${site.hostname}`);
  const distribution = yield* observeDistribution(site);
  expect(distribution.status).toEqual("ACTIVE");
  const backend = distribution.config.backend;
  expect(backend.type).toEqual(expected.type);
  if (expected.type === "http" && backend.type === "http") {
    // STACKIT normalizes the origin, so compare the hosts.
    expect(new URL(backend.originUrl).host).toEqual(new URL(expected.originUrl).host);
  }
});

/** The function is deployed and is the revision state says it is. */
export const expectFunctionServing = Effect.fn(function* (
  projectId: string,
  server: { functionId: string; currentRevision: string | undefined },
) {
  const observed = yield* functions.getFunction({ projectId, functionId: server.functionId });
  expect(observed.state).toEqual("ACTIVE");
  expect(observed.current_revision).toEqual(server.currentRevision);
});

/** A GET's `Cache-Control`, retried through a fresh hostname and a cold start. */
export const cacheControlOf = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url);
    if (response.status !== 200) {
      return yield* Effect.fail(new Error(`${url} answered ${response.status}`));
    }
    return { cacheControl: response.headers["cache-control"], body: yield* response.text };
  }).pipe(Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 30 }));

/** The first content-hashed file a page refers to. */
export const hashedAssetOf = (html: string) =>
  /(?:src|href)="([^"]*\/assets\/[^"]+)"/.exec(html)?.[1];

export const expectDistributionGone = (site: DeployedSite) =>
  observeDistribution(site).pipe(
    Effect.as("present" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (state) => state === "gone",
      times: 24,
    }),
    Effect.map((state) => expect(state).toEqual("gone")),
  );

/** Out-of-band: the distribution and the function are gone. */
export const expectServerSiteGone = Effect.fn(function* (site: DeployedSite, functionId: string) {
  yield* expectDistributionGone(site);
  yield* expectFunctionGone(site.projectId, functionId);
});

/** Out-of-band: the distribution and the bucket are gone. */
export const expectAssetSiteGone = Effect.fn(function* (
  site: DeployedSite,
  bucket: { bucketName: string; region: string },
) {
  yield* expectDistributionGone(site);
  const state = yield* objectStorage
    .getBucket({ projectId: site.projectId, region: bucket.region, bucketName: bucket.bucketName })
    .pipe(
      Effect.as("present" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("3 seconds"),
        until: (observed) => observed === "gone",
        times: 20,
      }),
    );
  expect(state).toEqual("gone");
});
