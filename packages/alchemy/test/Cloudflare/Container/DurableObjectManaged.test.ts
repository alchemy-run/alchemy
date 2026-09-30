import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import { assert, describe, expect } from "alchemy-test";
import { Stage } from "@/Stage.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import makeStack from "./fixtures/durable-object/stack.ts";

const DEPLOY_PLACEHOLDER = "Alchemy worker is being deployed...";

// Retry a freshly deployed route until it answers 200 with `expected` in the
// body: a cold container takes a few seconds to bind its port.
const fetchReady = (url: URL, expected: string) =>
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.setHeader("connection", "close")),
    );
    return yield* client.get(url).pipe(
      Effect.flatMap((r) =>
        r.text.pipe(
          Effect.flatMap((body) =>
            r.status === 200 &&
            !body.includes(DEPLOY_PLACEHOLDER) &&
            body.includes(expected)
              ? Effect.succeed(body)
              : Effect.fail(new Error(`not ready: ${r.status} ${body}`)),
          ),
        ),
      ),
      Effect.timeout("10 seconds"),
      Effect.retry({
        schedule: Schedule.spaced("3 seconds"),
        times: 40,
      }),
    );
  });

describe.sequential(
  "Durable Object-managed container (live)",
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:container",
      "provider:cloudflare:worker",
      "live",
    ],
  },
  () => {
    const stage = process.env.ALCHEMY_TEST_STAGE ?? "test-live";
    const Stack = makeStack();
    const services = Layer.effectContext(
      Stack.pipe(Effect.map((stack) => stack.services)),
    ).pipe(Layer.provide(Layer.succeed(Stage, stage)));
    const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
      providers: Cloudflare.providers(),
      state: Cloudflare.state(),
      stage,
      dev: false,
    });
    const stack = beforeAll(deploy(Stack), { timeout: 300_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
      timeout: 120_000,
    });

    test(
      "creates an image-less application scheduled by the Durable Object",
      Effect.gen(function* () {
        const { accountId } = yield* stack;
        const apps = yield* Containers.listContainerApplications({ accountId });
        const app = apps.find(
          (candidate) =>
            candidate.schedulingPolicy === "durable_object" &&
            candidate.name.includes("sandbox"),
        );
        assert(app, "no durable_object application was created");
        expect(app.durableObjects?.namespaceId).toBeDefined();
        expect(app.configuration?.image ?? undefined).toBeUndefined();
      }).pipe(Effect.provide(services)),
      { timeout: 120_000 },
    );

    test(
      "declares every named image with the Worker",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const body = yield* fetchReady(new URL("/images", url), "echo");
        expect(JSON.parse(body)).toEqual(["echo", "whoami"]);
      }),
      { timeout: 180_000 },
    );

    test(
      "starts the image the Durable Object picks",
      Effect.gen(function* () {
        const { url } = yield* stack;
        // The echo image reflects the request as JSON; whoami reports its
        // hostname. Each proves the chosen image is the one running.
        const echo = yield* fetchReady(new URL("/?image=echo", url), "method");
        expect(echo).toContain("method");
        const whoami = yield* fetchReady(
          new URL("/?image=whoami", url),
          "Hostname",
        );
        expect(whoami).toContain("Hostname");
      }),
      { timeout: 240_000 },
    );

    test(
      "starts Cloudflare's system image from an image-less container",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const body = yield* fetchReady(new URL("/system", url), "system:v");
        expect(body).toMatch(/^system:v\d+/);
      }),
      { timeout: 180_000 },
    );

    test(
      "restores a container from a filesystem snapshot",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const token = `alchemy-${Date.now()}`;
        // Wait for the Worker, then run the round trip once: it takes longer
        // than one readiness poll, and a retry would restart it mid-flight.
        yield* fetchReady(new URL("/images", url), "echo");
        const client = yield* HttpClient.HttpClient;
        const response = yield* client
          .get(new URL(`/snapshot?token=${token}`, url))
          .pipe(Effect.timeout("200 seconds"));
        const body = yield* response.text;
        const result = JSON.parse(body) as {
          snapshot?: { id: string };
          restored?: string;
          error?: string;
          steps: Array<{ step: string; ms: number }>;
        };
        yield* Effect.logInfo(`snapshot round trip: ${body}`);
        expect(result.error).toBeUndefined();
        expect(result.snapshot?.id).toBeTruthy();
        expect(result.restored).toBe(token);
      }),
      { timeout: 240_000 },
    );
  },
);
