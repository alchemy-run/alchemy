import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";

import KinesisVideoTestFunctionLive, {
  KinesisVideoTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "KinesisVideoBindings");

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry transient 5xx from the shared fixture under parallel-suite load;
// genuine 4xx failures surface immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

describe("KinesisVideo Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "KinesisVideo test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("KinesisVideo test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* KinesisVideoTestFunction;
        }).pipe(Effect.provide(KinesisVideoTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      yield* Effect.logInfo(
        `KinesisVideo test setup: probing readiness at ${baseUrl}/info`,
      );
      yield* HttpClient.get(`${baseUrl}/info`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.void
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 240_000,
  });

  describe("GetHLSStreamingSessionURL", () => {
    test.provider(
      "lambda reaches the archived-media data plane through the binding",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(HttpClientRequest.get(`${baseUrl}/hls`));
          expect(response.status).toBe(200);
          const body = (yield* response.json) as {
            url?: string;
            errorTag?: string;
          };
          // The fixture stream has never ingested media, so LIVE playback
          // deterministically returns the archived-media data plane's typed
          // no-fragments error. Getting THIS tag (and not NotAuthorized /
          // an unknown error) proves GetDataEndpoint resolution, IAM, and
          // the signed data-plane call all work.
          expect(body.errorTag).toBe("ResourceNotFoundException");
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetIceServerConfig", () => {
    test.provider(
      "lambda fetches TURN servers through the binding",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(HttpClientRequest.get(`${baseUrl}/ice`));
          expect(response.status).toBe(200);
          const body = (yield* response.json) as {
            servers: {
              uris: string[];
              hasCredentials: boolean;
              ttl?: number;
            }[];
          };
          expect(body.servers.length).toBeGreaterThan(0);
          const turn = body.servers.find((s) =>
            s.uris.some((uri) => uri.startsWith("turn")),
          );
          expect(turn).toBeDefined();
          expect(turn?.hasCredentials).toBe(true);
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetMedia", () => {
    test.provider(
      "lambda opens a media connection through the binding",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/media`),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as {
            ok: boolean;
            contentType?: string;
            timedOut?: boolean;
            errorTag?: string;
          };
          // ok:false would carry a typed auth/endpoint error tag — the
          // empty stream either answers immediately (contentType) or idles
          // until the fixture's bounded timeout; both are accepted calls.
          expect(body.ok).toBe(true);
        }),
      { timeout: 120_000 },
    );
  });
});
