import * as NodeCrypto from "node:crypto";
import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { hostLabelOf } from "@alchemy.run/convex/internal/selfhosted";
import { expect } from "@alchemy.run/test";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as rds from "@distilled.cloud/aws/rds";
import * as Output from "alchemy/Output";
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { SELF_HOSTED_FIXTURE_DIR, scratchApp } from "../support.ts";

/** The backend image tests run, pinned because Convex migrations only go forward. */
export const BACKEND_IMAGE =
  "ghcr.io/convex/convex-backend:latest@sha256:207cf95def42f01614b6e3af0af5c20d0dcaa5ff2adf258ee7bc9555576644fa";

/** The standing Cloudflare test zone. Each suite's public domain sits under it. */
export const TEST_ZONE = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

/** Self-hosted suites take tens of minutes, so `--fast` skips them. */
export const skipSlow = !!process.env.FAST;

/**
 * A suite's public domain for this stage. Kept short, because ACM refuses a
 * certificate whose first name is over 64 characters: a long stage is
 * replaced by its hash, so it still differs per stage.
 */
export const domainFor = Effect.fn(function* (suite: string, stage: string) {
  const label = `cx-${suite}-${hostLabelOf(stage)}`;
  if (label.length <= 20) return `${label}.${TEST_ZONE}`;
  return `cx-${suite}-${yield* shortHash(label)}.${TEST_ZONE}`;
});

/**
 * A stage as a short hostname label. Hosts are named `<stage>.<domain>`, and
 * the pair has to fit in ACM's 64 characters, so a long stage is hashed.
 */
export const shortStageLabel = Effect.fn(function* (stage: string) {
  const label = hostLabelOf(stage);
  return label.length <= 16 ? label : `s-${yield* shortHash(label)}`;
});

const shortHash = (value: string) =>
  Effect.sync(() => NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 8));

export class TestZoneNotFound extends Data.TaggedError("TestZoneNotFound")<{
  readonly zone: string;
}> {}

/** The id of the standing Cloudflare test zone. */
export const testZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: TEST_ZONE });
  if (!zone) return yield* new TestZoneNotFound({ zone: TEST_ZONE });
  return zone.id;
});

/**
 * A Route 53 zone for `domain`, delegated from the Cloudflare test zone so the
 * internet resolves it, and ACM can validate certificates in it.
 */
export const DelegatedZone = Effect.fn(function* (parentZoneId: string, domain: string) {
  const zone = yield* AWS.Route53.HostedZone("Zone", {
    name: domain,
    // Removes the validation and host records with the zone.
    forceDestroy: true,
  });
  // Route 53 always assigns four nameservers.
  yield* Effect.forEach([0, 1, 2, 3], (index) =>
    Cloudflare.DNS.Record(`Delegation${index}`, {
      zoneId: parentZoneId,
      name: domain,
      type: "NS",
      content: Output.map(zone.nameServers, (nameServers) => nameServers[index]!),
    }),
  );
  return zone;
});

/** A private copy of the self-hosted fixture app. */
export const selfHostedApp = (name: string) => scratchApp(name, SELF_HOSTED_FIXTURE_DIR);

const messages = anyApi.messages!;

const withClient = <A, E, R>(url: string, use: (client: ConvexClient) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new ConvexClient(url)),
    use,
    (client) => Effect.promise(() => client.close()),
  );

const texts = (client: ConvexClient) =>
  Effect.promise(() => client.query(messages.list!, {})).pipe(
    Effect.map((rows: Array<{ text: string }>) => rows.map((row) => row.text)),
  );

/**
 * Proves a deployed backend works for a real client: a query, a mutation seen
 * through a live websocket subscription, and an HTTP action on the site host.
 * `holdSocketSeconds` proves the load balancer leaves an idle socket open.
 */
export const assertRuntime = (input: {
  url: string;
  /** Checks the HTTP action on the site host, for an app that defines one. */
  siteUrl?: string;
  text: string;
  holdSocketSeconds?: number;
}) =>
  withClient(input.url, (client) =>
    Effect.gen(function* () {
      const seen = Effect.callback<void>((resume) => {
        const unsubscribe = client.onUpdate(messages.list!, {}, (rows: Array<{ text: string }>) => {
          if (rows.some((row) => row.text === input.text)) resume(Effect.void);
        });
        return Effect.sync(() => unsubscribe());
      }).pipe(Effect.timeout("30 seconds"));
      const add = (text: string) => Effect.promise(() => client.mutation(messages.add!, { text }));

      yield* Effect.all([seen, add(input.text)], { concurrency: "unbounded" });
      expect(yield* texts(client)).toContain(input.text);

      if (input.siteUrl !== undefined) {
        const http = yield* HttpClient.HttpClient;
        const site = yield* http.get(`${input.siteUrl}/hello`);
        expect(site.status).toBe(200);
        expect(yield* site.text).toBe("hello from an http action");
      }

      if (input.holdSocketSeconds !== undefined) {
        yield* Effect.sleep(`${input.holdSocketSeconds} seconds`);
        const later = `${input.text} after waiting`;
        yield* add(later);
        expect(yield* texts(client)).toContain(later);
        expect(client.connectionState().isWebSocketConnected).toBe(true);
      }
    }),
  );

/** The rows a fresh client sees. */
export const listMessages = (url: string) => withClient(url, texts);

/** Whether no RDS instance serves `host` any more, or the one that did is going. */
export const databaseServerGone = (host: string) =>
  rds
    .describeDBInstances({})
    .pipe(
      Effect.map(
        ({ DBInstances }) =>
          !(DBInstances ?? []).some(
            (instance) =>
              instance.Endpoint?.Address === host && instance.DBInstanceStatus !== "deleting",
          ),
      ),
    );

/** Whether an ECS service has gone, with or without its cluster. */
export const serviceGone = (cluster: string, service: string) =>
  ecs.describeServices({ cluster, services: [service] }).pipe(
    Effect.map(({ services }) => (services ?? []).every((item) => item.status === "INACTIVE")),
    Effect.catchTag("ClusterNotFoundException", () => Effect.succeed(true)),
  );
