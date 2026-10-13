import { fileURLToPath } from "node:url";
import * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as iam from "@distilled.cloud/aws/iam";
import * as LambdaWeb from "@distilled.cloud/aws/lambda-web";
import { expect } from "alchemy-test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import EffectWebFunctionLive, { EffectWebFunction } from "./fixtures/web/effect-web.ts";

const asyncFetchMain = fileURLToPath(new URL("./fixtures/web/async-fetch.ts", import.meta.url));
const asyncListenMain = fileURLToPath(new URL("./fixtures/web/async-listen.ts", import.meta.url));
const prebuiltMain = fileURLToPath(new URL("./fixtures/web/prebuilt/server.mjs", import.meta.url));

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:iam", "provider:aws:lambda", "live"];

class UnexpectedStatus extends Error {}

/**
 * Send a request until the endpoint answers 200. A new endpoint's domain
 * and a freshly shifted revision take a few seconds to serve.
 */
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.succeed(response)
        : Effect.fail(new UnexpectedStatus(`${request.url} returned ${response.status}`)),
    ),
    Effect.retry({
      schedule: Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(30)]),
    }),
  );

const getText = (url: string) =>
  send(HttpClientRequest.get(url)).pipe(Effect.flatMap((response) => response.text));

/** Poll `url` until its body satisfies `until`. */
const getTextUntil = (url: string, until: (body: string) => boolean) =>
  getText(url).pipe(Effect.repeat({ schedule: Schedule.spaced("2 seconds"), until, times: 30 }));

/**
 * Read a streamed body, recording when each chunk arrived. A buffered
 * bridge delivers every chunk at once; a streaming one spreads them over
 * the time the handler took to produce them.
 */
const readChunks = (response: HttpClientResponse.HttpClientResponse) =>
  response.stream.pipe(
    Stream.decodeText,
    Stream.mapEffect((text) => Effect.map(Clock.currentTimeMillis, (at) => ({ at, text }))),
    Stream.runCollect,
    Effect.map((chunks) => Array.from(chunks)),
  );

const expectStreamed = (url: string) =>
  Effect.gen(function* () {
    const chunks = yield* send(HttpClientRequest.get(`${url}/stream`)).pipe(
      Effect.flatMap(readChunks),
    );
    expect(chunks.map((c) => c.text).join("")).toBe("one\ntwo\nthree\n");
    // The handler sleeps 600 ms between chunks; buffered delivery would
    // land them together.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.at(-1)!.at - chunks[0]!.at).toBeGreaterThan(800);
  });

const getEndpoint = (functionName: string) =>
  LambdaWeb.getWebFunctionEndpoint({ functionName, endpointName: "default" });

const expectFunctionDeleted = (functionName: string, roleName: string) =>
  Effect.gen(function* () {
    const fn = yield* LambdaWeb.getWebFunction({ functionName }).pipe(
      Effect.map(() => true),
      Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(false)),
    );
    expect(fn).toBe(false);
    const role = yield* iam.getRole({ RoleName: roleName }).pipe(
      Effect.map(() => true),
      Effect.catchTag("NoSuchEntityException", () => Effect.succeed(false)),
    );
    expect(role).toBe(false);
    const logGroups = yield* Logs.describeLogGroups({
      logGroupNamePrefix: `/aws/lambda/web/${functionName}`,
    });
    expect(logGroups.logGroups ?? []).toEqual([]);
  });

test.provider(
  "async fetch export: create, update, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const declare = (props: Partial<AWS.Lambda.WebFunctionProps>) =>
        AWS.Lambda.WebFunction("AsyncFetch", { main: asyncFetchMain, ...props });

      const created = yield* stack.deploy(declare({ env: { GREETING: "hello" } }));
      expect(created.url).toBe(`https://${created.domainName}`);
      expect(created.domainName).toContain(".lambda-web.");

      const root = yield* send(HttpClientRequest.get(created.url));
      expect(yield* root.text).toBe("greeting=hello");
      expect(root.headers["x-fixture"]).toBe("async-fetch");
      expect(root.headers["lambda-web-request-id"]).toBeTruthy();

      const echo = yield* send(
        HttpClientRequest.post(`${created.url}/echo`).pipe(
          HttpClientRequest.bodyText("ping", "text/plain"),
        ),
      ).pipe(Effect.flatMap((response) => response.json));
      expect(echo).toEqual({ method: "POST", body: "ping" });

      yield* expectStreamed(created.url);

      // Out-of-band: one endpoint, all traffic on the deployed revision.
      const endpoint = yield* getEndpoint(created.functionName);
      expect(endpoint.endpointType).toBe("HomeRegion");
      expect(endpoint.authType).toBe("ApplicationManaged");
      expect(endpoint.revisionWeights).toEqual([{ revisionId: created.revisionId, weight: 100 }]);
      const revision = yield* LambdaWeb.getWebFunctionRevision({
        functionName: created.functionName,
        revisionId: created.revisionId,
      });
      expect(revision.buildConfig.runtimeConfig.runtime).toBe("nodejs24.x");
      expect(revision.serviceConfig.maxConcurrencyPerEnvironment).toBe(64);
      expect(revision.serviceConfig.timeoutSeconds).toBe(30);
      expect(revision.serviceConfig.environmentVariables?.GREETING).toBe("hello");

      // Re-planning unchanged props is a noop.
      const plan = yield* stack.plan(declare({ env: { GREETING: "hello" } }));
      expect(plan.resources.AsyncFetch).toMatchObject({ action: "noop" });

      // Update: new env + concurrency create a revision; the endpoint
      // shifts to it and picks up the rate limit.
      const updated = yield* stack.deploy(
        declare({ env: { GREETING: "updated" }, maxConcurrencyPerEnvironment: 32, rateLimit: 100 }),
      );
      expect(updated.functionName).toBe(created.functionName);
      expect(updated.url).toBe(created.url);
      expect(updated.revisionId).not.toBe(created.revisionId);
      const updatedEndpoint = yield* getEndpoint(updated.functionName);
      expect(updatedEndpoint.revisionWeights).toEqual([
        { revisionId: updated.revisionId, weight: 100 },
      ]);
      expect(updatedEndpoint.throttleConfig?.rateLimit).toBe(100);
      const updatedRevision = yield* LambdaWeb.getWebFunctionRevision({
        functionName: updated.functionName,
        revisionId: updated.revisionId,
      });
      expect(updatedRevision.serviceConfig.maxConcurrencyPerEnvironment).toBe(32);
      expect(yield* getTextUntil(updated.url, (body) => body === "greeting=updated")).toBe(
        "greeting=updated",
      );

      // Endpoint-only change: no new revision; unsigned callers are refused.
      const iamAuth = yield* stack.deploy(
        declare({
          env: { GREETING: "updated" },
          maxConcurrencyPerEnvironment: 32,
          rateLimit: 100,
          authType: "IamAuth",
        }),
      );
      expect(iamAuth.revisionId).toBe(updated.revisionId);
      expect((yield* getEndpoint(iamAuth.functionName)).authType).toBe("IamAuth");
      const unsigned = yield* HttpClient.get(iamAuth.url).pipe(
        Effect.map((response) => response.status),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (status) => status === 403,
          times: 30,
        }),
      );
      expect(unsigned).toBe(403);

      // Endpoint type and Regions are immutable: changing them replaces.
      const multiRegion = yield* stack.plan(
        declare({ env: { GREETING: "updated" }, regions: ["us-east-1"] }),
      );
      expect(multiRegion.resources.AsyncFetch).toMatchObject({ action: "replace" });

      yield* stack.destroy();
      yield* expectFunctionDeleted(created.functionName, created.roleName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags, timeout: 300_000 },
);

test.provider(
  "async server that listens on its own",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        AWS.Lambda.WebFunction("AsyncListen", {
          main: asyncListenMain,
          // Fixtures live inside the `alchemy` package, which the bundler
          // marks pure: its top-level `listen()` call would be dropped.
          build: { pure: false },
        }),
      );
      const body = yield* getText(`${fn.url}/hello`);
      expect(body).toMatch(/^listening on .+:\d+ path=\/hello$/);

      yield* stack.destroy();
      yield* expectFunctionDeleted(fn.functionName, fn.roleName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags, timeout: 240_000 },
);

test.provider(
  "Effect fetch handler with bindings and streaming",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(EffectWebFunction.pipe(Effect.provide(EffectWebFunctionLive)));

      expect(yield* getText(fn.url)).toBe("hello from effect");

      const runtime = (yield* send(HttpClientRequest.get(`${fn.url}/runtime`)).pipe(
        Effect.flatMap((response) => response.json),
      )) as { endpoint?: string; requestId?: string; hasCredentials: boolean; region?: string };
      expect(runtime.endpoint).toMatch(/:\d+$/);
      expect(runtime.requestId).toBeTruthy();
      expect(runtime.hasCredentials).toBe(true);

      // The S3 bindings granted the execution role access and the runtime
      // signs with the role's credentials.
      const s3 = yield* send(HttpClientRequest.get(`${fn.url}/s3?key=effect.txt`)).pipe(
        Effect.flatMap((response) => response.json),
      );
      expect(s3).toEqual({ key: "effect.txt", body: `written by ${stack.stage}` });

      yield* expectStreamed(fn.url);

      yield* stack.destroy();
      yield* expectFunctionDeleted(fn.functionName, fn.roleName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags, timeout: 300_000 },
);

test.provider(
  "prebuilt directory deployed as-is",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        AWS.Lambda.WebFunction("Prebuilt", { main: prebuiltMain, bundle: false }),
      );
      const body = yield* getText(fn.url);
      expect(body).toMatch(/^prebuilt on .+:\d+$/);

      yield* stack.destroy();
      yield* expectFunctionDeleted(fn.functionName, fn.roleName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags, timeout: 240_000 },
);

test.provider(
  "a rejected create does not strand the execution role",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const declaration = AWS.Lambda.WebFunction("Rejected", {
        main: asyncFetchMain,
        // Reserved for Lambda: CreateWebFunction rejects the revision after
        // the execution role already exists.
        env: { AWS_LAMBDA_HTTP_ENDPOINT: "127.0.0.1:1" },
      });
      const failure = yield* stack.deploy(declaration).pipe(Effect.flip);
      expect(String(failure)).toContain("ValidationException");

      // Physical names start with the (truncated) stack name.
      const prefix = stack.name
        .replaceAll(/[^a-zA-Z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 32);
      const roles = iam.listRoles.items({}).pipe(
        Stream.filter((role) => role.RoleName.startsWith(prefix)),
        Stream.map((role) => role.RoleName),
        Stream.runCollect,
        Effect.map((names) => Array.from(names)),
      );
      expect((yield* roles).length).toBeGreaterThan(0);

      yield* stack.destroy();
      expect(yield* roles).toEqual([]);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { tags, timeout: 180_000 },
);
