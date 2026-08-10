import * as AWS from "alchemy/AWS";
import * as Core from "alchemy/Test/Core";
import * as Test from "alchemy/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import AuroraAuthFunctionLive, {
  AuroraAuthFunction,
} from "./fixtures/aurora-handler.ts";
import { AuthHttpError, getJson, postJson, toCookieHeader } from "../http.ts";

/**
 * Aurora Serverless v2 provisioning takes ~10 minutes — far beyond the
 * suite's speed budget, so the full lifecycle is opt-in:
 *
 *   BETTER_AUTH_TEST_AURORA=1 bun run test test/AWS/Aurora.test.ts --profile testing
 *
 * The Data API dialect itself is pinned ungated by AuroraDataApi.test.ts.
 */
const enabled = !!process.env.BETTER_AUTH_TEST_AURORA;

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "BetterAuthAurora");

let baseUrl: string;

const readinessRetry = Effect.retry({
  schedule: Schedule.exponential("3 seconds", 1.5),
  times: 10,
});

beforeAll(
  Effect.gen(function* () {
    if (!enabled) {
      return;
    }
    yield* sharedStack.destroy();
    const { functionUrl } = yield* sharedStack.deploy(
      Effect.gen(function* () {
        return yield* AuroraAuthFunction;
      }).pipe(Effect.provide(AuroraAuthFunctionLive)),
    );
    expect(functionUrl).toBeTruthy();
    baseUrl = functionUrl!.replace(/\/+$/, "");
    yield* getJson<{ email: string | null }>(`${baseUrl}/me`).pipe(
      Effect.tapError((error) =>
        Effect.logWarning(`Aurora Lambda not ready yet: ${error.message}`),
      ),
      readinessRetry,
    );
  }),
  { timeout: 1_500_000 },
);

afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
  timeout: 1_500_000,
});

test.skipIf(!enabled)(
  "Lambda -> Aurora over the Data API: sign-up, sign-in, session",
  Effect.gen(function* () {
    const email = "aurora-user@example.com";
    const password = "password1234";

    yield* postJson(`${baseUrl}/auth/sign-up/email`, {
      email,
      password,
      name: "Aurora User",
    }).pipe(
      Effect.filterOrFail(
        (response) =>
          response.status === 200 ||
          response.body.includes("USER_ALREADY_EXISTS"),
        (response) => new AuthHttpError({ url: baseUrl, ...response }),
      ),
    );

    const signIn = yield* postJson(`${baseUrl}/auth/sign-in/email`, {
      email,
      password,
    }).pipe(
      Effect.filterOrFail(
        (response) => response.status === 200,
        (response) => new AuthHttpError({ url: baseUrl, ...response }),
      ),
    );
    expect(signIn.setCookies.length).toBeGreaterThan(0);

    const me = yield* getJson<{ email: string | null }>(`${baseUrl}/me`, {
      cookie: toCookieHeader(signIn.setCookies),
    });
    expect(me.email).toBe(email);
  }),
  { timeout: 120_000 },
);
