import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Drizzle from "@/Drizzle";
import * as Neon from "@/Neon";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { Hyperdrive } from "./fixtures/database.ts";
import BetterAuthPgWorker from "./fixtures/worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(
    Cloudflare.providers(),
    Neon.providers(),
    Drizzle.providers(),
  ),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = Alchemy.Stack(
  "BetterAuthPostgresDrizzleStack",
  {
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Neon.providers(),
      Drizzle.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const hd = yield* Hyperdrive;
    const worker = yield* BetterAuthPgWorker;
    return {
      hyperdriveId: hd.hyperdriveId,
      url: worker.url.as<string>(),
    };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "postgresDrizzle worker serves better-auth signup over Neon Postgres",
  Effect.gen(function* () {
    const out = yield* stack;
    const workerUrl = out.url;
    expect(workerUrl).toBeTypeOf("string");

    const client = yield* HttpClient.HttpClient;

    // Warm-up: workers.dev URLs take a few seconds to start serving.
    const root = yield* client.get(workerUrl).pipe(
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 10,
      }),
    );
    expect(root.status).toBe(200);

    const email = `test-${crypto.randomUUID()}@example.com`;
    const password = "correct-horse-battery-staple";

    const signUp = yield* HttpClient.execute(
      HttpClientRequest.post(`${workerUrl}/api/auth/sign-up/email`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          email,
          password,
          name: "Test User",
        }),
      ),
    ).pipe(
      Effect.retry({
        schedule: Schedule.exponential("1 second"),
        times: 5,
      }),
    );

    if (signUp.status !== 200) {
      const text = yield* signUp.text;
      throw new Error(`sign-up failed with status ${signUp.status}: ${text}`);
    }

    const signIn = yield* HttpClient.execute(
      HttpClientRequest.post(`${workerUrl}/api/auth/sign-in/email`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ email, password }),
      ),
    );
    expect(signIn.status).toBe(200);
    const session = (yield* signIn.json) as { user?: { email?: string } };
    expect(session.user?.email).toBe(email);
  }).pipe(logLevel),
  { timeout: 300_000 },
);
