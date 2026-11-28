import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { Bucket, ProviderLive } from "@alchemy.run/cloudflare/R2/Bucket";
import { expect, it } from "@alchemy.run/test";
import { apiTokenCredentials, Credentials } from "@distilled.cloud/cloudflare/Credentials";
import type * as r2 from "@distilled.cloud/cloudflare/r2";
import * as Drift from "alchemy/Drift";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { inMemoryState, State, type ResourceState } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

const accountId = "0123456789abcdef0123456789abcdef";
const bucketName = "drift-fixture";

type BucketState = {
  bucket: r2.GetBucketResponse;
  domains: r2.ListBucketDomainCustomsResponse;
  lifecycle: r2.GetBucketLifecycleResponse;
  cors: r2.GetBucketCorsResponse;
  managedDomain: r2.ListBucketDomainManagedsResponse;
  locks: r2.GetBucketLockResponse;
  localUploads: r2.GetBucketLocalUploadsResponse;
};

const liveState = (): BucketState => ({
  bucket: {
    name: bucketName,
    storageClass: "Standard",
    location: "weur",
    jurisdiction: "default",
  },
  domains: { domains: [] },
  lifecycle: { rules: [] },
  cors: { rules: [] },
  managedDomain: { bucketId: "bucket-id", domain: "drift-fixture.r2.dev", enabled: false },
  locks: { rules: [] },
  localUploads: { enabled: false },
});

const saved: Bucket["Attributes"] = {
  bucketName,
  accountId,
  storageClass: "Standard",
  jurisdiction: "default",
  location: "weur",
  domains: [],
  lifecycleRules: [],
  cors: [],
  locks: undefined,
  localUploads: undefined,
  publicDomain: undefined,
};

const endpoint = (url: string): keyof BucketState | undefined => {
  const path = new URL(url).pathname;
  if (path.endsWith("/domains/custom")) return "domains";
  if (path.includes("/domains/custom/")) return "domains";
  if (path.endsWith("/domains/managed")) return "managedDomain";
  if (path.endsWith("/lifecycle")) return "lifecycle";
  if (path.endsWith("/cors")) return "cors";
  if (path.endsWith("/lock")) return "locks";
  if (path.endsWith("/local-uploads")) return "localUploads";
  if (path.endsWith(`/buckets/${bucketName}`)) return "bucket";
  return undefined;
};

const fixture = (
  state: BucketState,
  failures: Partial<Record<keyof BucketState, { code: number; status: number }>> = {},
) => {
  const requests: Array<keyof BucketState> = [];
  const writes: Array<keyof BucketState> = [];
  const client = HttpClient.make((request) => {
    const key = endpoint(request.url);
    if (!key) return Effect.die(new Error(`Unexpected R2 operation: ${request.url}`));
    requests.push(key);
    if (
      request.method === "DELETE" &&
      (key === "cors" ||
        (key === "domains" && new URL(request.url).pathname.includes("/domains/custom/")))
    ) {
      if (key === "cors") state.cors.rules = [];
      if (key === "domains") {
        const domain = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1)!);
        state.domains.domains = state.domains.domains.filter((item) => item.domain !== domain);
      }
      writes.push(key);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ success: true, errors: [], messages: [], result: {} }),
        ),
      );
    }
    if (
      request.method === "PUT" &&
      (key === "lifecycle" || key === "locks" || key === "localUploads" || key === "managedDomain")
    ) {
      const body: HttpBody.HttpBody = request.body;
      if (body._tag !== "Uint8Array") {
        return Effect.die(new Error("R2 configuration PUT should contain JSON"));
      }
      const payload = JSON.parse(new TextDecoder().decode(body.body)) as Record<string, unknown>;
      if (key === "lifecycle") {
        state.lifecycle = {
          rules: (payload.rules ?? []) as r2.GetBucketLifecycleResponse["rules"],
        };
      } else if (key === "locks") {
        state.locks = { rules: (payload.rules ?? []) as r2.GetBucketLockResponse["rules"] };
      } else if (key === "localUploads") {
        state.localUploads.enabled = payload.enabled === true;
      } else {
        state.managedDomain.enabled = payload.enabled === true;
      }
      writes.push(key);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            success: true,
            errors: [],
            messages: [],
            result: key === "managedDomain" ? state.managedDomain : {},
          }),
        ),
      );
    }
    if (request.method !== "GET") {
      return Effect.die(new Error(`Unexpected mutation: ${request.method} ${request.url}`));
    }
    const failure = failures[key];
    const body = failure
      ? {
          success: false,
          errors: [{ code: failure.code, message: "Fixture Cloudflare error" }],
          messages: [],
          result: null,
        }
      : { success: true, errors: [], messages: [], result: state[key] };
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, Response.json(body, { status: failure?.status ?? 200 })),
    );
  });
  const environment = Layer.mergeAll(
    Layer.succeed(
      CloudflareEnvironment,
      Effect.succeed({
        type: "apiToken" as const,
        apiToken: Redacted.make("fixture-token"),
        accountId,
        source: { type: "env" as const },
      }),
    ),
    Layer.succeed(
      Credentials,
      Effect.succeed(apiTokenCredentials({ apiToken: Redacted.make("fixture-token") })),
    ),
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(Stage, "fixture"),
    Layer.succeed(Stack, {
      name: "r2-bucket-drift-test",
      stage: "fixture",
      resources: {},
      bindings: {},
      actions: {},
    }),
  );
  return {
    requests,
    writes,
    provider: ProviderLive().pipe(Layer.provideMerge(environment)),
  };
};

const read = (output: Bucket["Attributes"], olds: Bucket["Props"] | undefined = {}) =>
  Effect.gen(function* () {
    const provider = yield* Bucket.Provider;
    return yield* provider.read!({
      id: "Bucket",
      fqn: "Bucket",
      instanceId: "r2-drift-test",
      output,
      olds,
    });
  });

it.effect(
  "R2 Bucket read observes live lifecycle, CORS, custom domains, and public domain",
  () =>
    Effect.gen(function* () {
      const state = liveState();
      state.lifecycle.rules = [
        {
          id: "expire-logs",
          enabled: true,
          conditions: { prefix: "logs/" },
          deleteObjectsTransition: { condition: { type: "Age", maxAge: 7200 } },
        },
      ];
      state.cors.rules = [
        {
          id: "browser",
          allowed: { methods: ["GET"], origins: ["https://new.example.com"] },
        },
      ];
      state.domains.domains = [
        {
          domain: "files.example.com",
          zoneId: "zone-123",
          enabled: true,
          status: { ownership: "active", ssl: "active" },
        },
      ];
      state.managedDomain.enabled = true;
      const { provider, requests } = fixture(state);
      const observed = yield* read(saved).pipe(Effect.provide(provider));

      expect(observed).toMatchObject({
        bucketName,
        lifecycleRules: [
          {
            id: "expire-logs",
            prefix: "logs/",
            deleteObjectsTransition: { condition: { type: "Age", maxAge: 7200 } },
          },
        ],
        cors: [{ id: "browser", allowedOrigins: ["https://new.example.com"] }],
        domains: [{ domain: "files.example.com", zoneId: "zone-123" }],
        publicDomain: "drift-fixture.r2.dev",
      });
      expect(requests).toEqual(
        expect.arrayContaining(["bucket", "lifecycle", "cors", "domains", "managedDomain"]),
      );
      expect(saved.lifecycleRules).toEqual([]);
    }),
  { tags: ["unit", "local", "provider:cloudflare", "provider:cloudflare:r2"] },
);

it.effect(
  "R2 Bucket read observes declared locks and Local Uploads without enabling either",
  () =>
    Effect.gen(function* () {
      const state = liveState();
      state.locks.rules = [
        { id: "hold", enabled: true, prefix: "secure/", condition: { type: "Indefinite" } },
      ];
      state.localUploads.enabled = true;
      const { provider, requests } = fixture(state);
      const output: Bucket["Attributes"] = {
        ...saved,
        locks: [],
        localUploads: false,
      };
      const observed = yield* read(output, { locks: [], localUploads: false }).pipe(
        Effect.provide(provider),
      );
      expect(observed?.locks).toEqual([
        { id: "hold", enabled: true, prefix: "secure/", condition: { type: "Indefinite" } },
      ]);
      expect(observed?.localUploads).toBe(true);
      expect(requests).toEqual(expect.arrayContaining(["locks", "localUploads"]));
    }),
  { tags: ["unit", "local", "provider:cloudflare", "provider:cloudflare:r2"] },
);

it.effect(
  "R2 Bucket read leaves never-declared locks and Local Uploads unmanaged",
  () =>
    Effect.gen(function* () {
      const state = liveState();
      const { provider, requests } = fixture(state);
      const observed = yield* read(saved).pipe(Effect.provide(provider));
      expect(observed?.locks).toBeUndefined();
      expect(observed?.localUploads).toBeUndefined();
      expect(requests).not.toContain("locks");
      expect(requests).not.toContain("localUploads");
    }),
  { tags: ["unit", "local", "provider:cloudflare", "provider:cloudflare:r2"] },
);

it.effect(
  "R2 Bucket read ignores Cloudflare-owned custom domain status transitions",
  () =>
    Effect.gen(function* () {
      const state = liveState();
      state.domains.domains = [
        {
          domain: "files.example.com",
          zoneId: "zone-123",
          enabled: true,
          status: { ownership: "active", ssl: "active" },
        },
      ];
      const prior: Bucket["Attributes"] = {
        ...saved,
        domains: [
          {
            domain: "files.example.com",
            zoneId: "zone-123",
            enabled: true,
            ciphers: undefined,
            minTLS: undefined,
            status: { ownership: "pending", ssl: "initializing" },
          },
        ],
      };
      const { provider } = fixture(state);
      const observed = yield* read(prior).pipe(Effect.provide(provider));
      expect(observed?.domains).toEqual(prior.domains);
    }),
  { tags: ["unit", "local", "provider:cloudflare", "provider:cloudflare:r2"] },
);

it.effect(
  "R2 Bucket read fails closed when an existing bucket's subresource is inaccessible",
  () =>
    Effect.gen(function* () {
      const { provider } = fixture(liveState(), { lifecycle: { status: 403, code: 10000 } });
      const outcome = yield* read(saved).pipe(Effect.provide(provider), Effect.result);
      expect(Result.isFailure(outcome)).toBe(true);
    }),
  { tags: ["unit", "local", "provider:cloudflare", "provider:cloudflare:r2"] },
);

it.effect(
  "R2 Bucket read propagates a failing domain endpoint instead of accepting empty domains",
  () =>
    Effect.gen(function* () {
      const { provider } = fixture(liveState(), { domains: { status: 500, code: 10000 } });
      const outcome = yield* read(saved).pipe(Effect.provide(provider), Effect.result);
      expect(Result.isFailure(outcome)).toBe(true);
    }),
  { tags: ["unit", "local", "provider:cloudflare", "provider:cloudflare:r2"] },
);

it.effect(
  "R2 Bucket read does not mistake a failing subresource 404 for a deleted bucket",
  () =>
    Effect.gen(function* () {
      const { provider } = fixture(liveState(), { lifecycle: { status: 404, code: 10006 } });
      const fiber = yield* Effect.forkChild(
        read(saved).pipe(Effect.provide(provider), Effect.result),
      );
      // Unit tests run under a virtual clock: advance the bounded R2
      // consistency backoff instead of waiting for a real timer.
      yield* TestClock.adjust("30 seconds");
      const outcome = yield* Fiber.join(fiber);
      expect(Result.isFailure(outcome)).toBe(true);
    }),
  { tags: ["unit", "local", "provider:cloudflare", "provider:cloudflare:r2"] },
);

it.effect(
  "R2 Bucket read keeps jurisdiction-restricted Local Uploads disabled",
  () =>
    Effect.gen(function* () {
      const state = liveState();
      state.bucket.jurisdiction = "us";
      const output: Bucket["Attributes"] = { ...saved, jurisdiction: "us", localUploads: false };
      const { provider, requests } = fixture(state);
      const observed = yield* read(output, { jurisdiction: "us", localUploads: false }).pipe(
        Effect.provide(provider),
      );
      expect(observed?.localUploads).toBe(false);
      expect(requests).not.toContain("localUploads");
    }),
  { tags: ["unit", "local", "provider:cloudflare", "provider:cloudflare:r2"] },
);

it.effect(
  "R2 Bucket read preserves missing-bucket semantics for the primary bucket GET",
  () =>
    Effect.gen(function* () {
      const { provider, requests } = fixture(liveState(), {
        bucket: { status: 404, code: 10006 },
      });
      expect(yield* read(saved).pipe(Effect.provide(provider))).toBeUndefined();
      expect(requests).toEqual(["bucket"]);
    }),
  { tags: ["unit", "local", "provider:cloudflare", "provider:cloudflare:r2"] },
);

it.effect(
  "R2 Bucket read reports no CORS rules when Cloudflare says NoCorsConfiguration",
  () =>
    Effect.gen(function* () {
      const { provider } = fixture(liveState(), { cors: { status: 404, code: 10059 } });
      const observed = yield* read(saved).pipe(Effect.provide(provider));
      expect(observed?.cors).toEqual([]);
    }),
  { tags: ["unit", "local", "provider:cloudflare", "provider:cloudflare:r2"] },
);

const identity = { name: "r2-bucket-drift-test", stage: "fixture" };

const stateRow = (
  props: Bucket["Props"] = { name: bucketName },
  attr: Bucket["Attributes"] = saved,
): ResourceState => ({
  kind: "resource",
  resourceType: Bucket.Type,
  namespace: undefined,
  fqn: "Bucket",
  logicalId: "Bucket",
  instanceId: "r2-drift-test",
  providerVersion: 0,
  status: "created",
  downstream: [],
  bindings: [],
  props,
  attr,
});

it.effect(
  "the drift engine detects an external lifecycle edit, repairs it and converges without churn",
  () => {
    const state = liveState();
    const { provider, writes } = fixture(state);
    const memory = inMemoryState({
      [identity.name]: { [identity.stage]: { Bucket: stateRow() } },
    });
    return Effect.gen(function* () {
      const unchanged = yield* Drift.detect(identity);
      expect(unchanged.resources.Bucket?.action).toBe("unchanged");
      expect(writes).toEqual([]);

      state.lifecycle.rules = [
        {
          id: "foreign-rule",
          enabled: true,
          conditions: { prefix: "sensitive/" },
          deleteObjectsTransition: { condition: { type: "Age", maxAge: 3600 } },
        },
      ];
      const detected = yield* Drift.detect(identity);
      expect(detected.resources.Bucket).toMatchObject({
        action: "drifted",
        attr: { lifecycleRules: [{ id: "foreign-rule", prefix: "sensitive/" }] },
      });
      expect(writes).toEqual([]);

      const repaired = yield* Drift.repair(identity);
      expect(repaired.resources.Bucket?.action).toBe("repaired");
      expect(writes).toEqual(["lifecycle"]);
      expect(state.lifecycle.rules).toEqual([]);

      const persisted = yield* (yield* yield* State).get({
        stack: identity.name,
        stage: identity.stage,
        fqn: "Bucket",
      });
      expect(persisted).toMatchObject({
        status: "updated",
        attr: { lifecycleRules: [] },
      });

      const after = yield* Drift.detect(identity);
      expect(after.resources.Bucket?.action).toBe("unchanged");
      expect(writes).toEqual(["lifecycle"]);
    }).pipe(Effect.provide(Layer.mergeAll(provider, memory)));
  },
  { tags: ["unit", "local", "provider:cloudflare", "provider:cloudflare:r2"] },
);

it.effect(
  "drift repair restores out-of-band CORS, domains, locks, Local Uploads and public access",
  () => {
    const state = liveState();
    state.domains.domains = [
      {
        domain: "unexpected.example.com",
        zoneId: "zone-123",
        enabled: true,
        status: { ownership: "active", ssl: "active" },
      },
    ];
    state.cors.rules = [
      {
        id: "foreign-cors",
        allowed: { methods: ["GET"], origins: ["https://unexpected.example.com"] },
      },
    ];
    state.locks.rules = [
      { id: "foreign-lock", enabled: true, prefix: "tmp/", condition: { type: "Indefinite" } },
    ];
    state.localUploads.enabled = true;
    state.managedDomain.enabled = true;
    const { provider, writes } = fixture(state);
    const props: Bucket["Props"] = {
      name: bucketName,
      domains: [],
      lifecycleRules: [],
      cors: [],
      locks: [],
      localUploads: false,
      publicAccess: false,
    };
    const memory = inMemoryState({
      [identity.name]: {
        [identity.stage]: {
          Bucket: stateRow(props, { ...saved, locks: [], localUploads: false }),
        },
      },
    });
    return Effect.gen(function* () {
      const detected = yield* Drift.detect(identity);
      expect(detected.resources.Bucket?.action).toBe("drifted");
      expect(writes).toEqual([]);

      const repaired = yield* Drift.repair(identity);
      expect(repaired.resources.Bucket?.action).toBe("repaired");
      expect(writes).toEqual(
        expect.arrayContaining(["domains", "cors", "locks", "localUploads", "managedDomain"]),
      );
      expect(writes).toHaveLength(5);
      expect(state.domains.domains).toEqual([]);
      expect(state.cors.rules).toEqual([]);
      expect(state.locks.rules).toEqual([]);
      expect(state.localUploads.enabled).toBe(false);
      expect(state.managedDomain.enabled).toBe(false);

      const after = yield* Drift.detect(identity);
      expect(after.resources.Bucket?.action).toBe("unchanged");
      expect(writes).toHaveLength(5);
    }).pipe(Effect.provide(Layer.mergeAll(provider, memory)));
  },
  { tags: ["unit", "local", "provider:cloudflare", "provider:cloudflare:r2"] },
);

it.effect(
  "the drift engine never repairs or modifies persisted state after a failed subresource read",
  () => {
    const { provider, writes } = fixture(liveState(), {
      lifecycle: { code: 10000, status: 403 },
    });
    const memory = inMemoryState({
      [identity.name]: { [identity.stage]: { Bucket: stateRow() } },
    });
    return Effect.gen(function* () {
      const outcome = yield* Drift.repair(identity).pipe(Effect.result);
      expect(Result.isFailure(outcome)).toBe(true);
      expect(writes).toEqual([]);
      const persisted = yield* (yield* yield* State).get({
        stack: identity.name,
        stage: identity.stage,
        fqn: "Bucket",
      });
      expect(persisted).toMatchObject({ status: "created", attr: saved });
    }).pipe(Effect.provide(Layer.mergeAll(provider, memory)));
  },
  { tags: ["unit", "local", "provider:cloudflare", "provider:cloudflare:r2"] },
);
