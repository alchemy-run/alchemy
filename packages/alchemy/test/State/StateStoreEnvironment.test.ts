import { CredentialsStore } from "@/Auth/Credentials.ts";
import { ProfileLive } from "@/Auth/Profile.ts";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { s3State, state as s3StateStore } from "@/AWS/StateStore/State.ts";
import * as CloudflareCredentials from "@/Cloudflare/Credentials.ts";
import * as CloudflareEnvironment from "@/Cloudflare/CloudflareEnvironment.ts";
import { State } from "@/State/State.ts";
import { PlatformServices } from "@/Util/PlatformServices";
import { describe, expect, it } from "alchemy-test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

/**
 * A state store may live in a different account than the resources a
 * stack deploys — the state bucket in a locked-down "state" account, the
 * workloads anywhere else. These tests pin the two halves of that
 * contract, hermetically (no sockets, no cloud):
 *
 * 1. the environment handed to the store is what actually signs and
 *    addresses its API calls, and
 * 2. it stays private to the store. The stack composes
 *    `providers.pipe(Layer.provideMerge(state))`, so a state-account
 *    environment that leaked out of the state layer would silently
 *    redirect every resource in the stack into the state account.
 */

const STATE_ACCOUNT = "111122223333";
const STATE_REGION = "eu-west-2";
const STATE_ACCESS_KEY = "AKIAEXAMPLESTATEACCT";
const STATE_BUCKET = "cross-account-alchemy-state";

/** An `AWSEnvironment` for the state account — no profile, no STS. */
const stateAccountEnvironment = Layer.succeed(
  AWSEnvironment,
  Effect.succeed({
    accountId: STATE_ACCOUNT,
    region: STATE_REGION,
    credentials: Effect.succeed({
      accessKeyId: Redacted.make(STATE_ACCESS_KEY),
      secretAccessKey: Redacted.make("secret-access-key"),
      region: STATE_REGION,
    }),
  }),
);

/** Minimal fetch signature — Bun's `typeof fetch` also demands `preconnect`. */
type FetchStub = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const stubHttpClient = (stub: FetchStub) =>
  FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, stub as typeof globalThis.fetch),
    ),
  );

interface CapturedRequest {
  readonly url: string;
  readonly authorization: string;
}

/**
 * Capture every request and answer 403 — a terminal S3 error, so the
 * store fails fast on its first call instead of retrying or needing a
 * full fixture of XML responses. The request itself is the assertion
 * subject.
 */
const capturingHttpClient = (captured: CapturedRequest[]) =>
  stubHttpClient((input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const headers = new Headers(
      input instanceof Request ? input.headers : init?.headers,
    );
    captured.push({ url, authorization: headers.get("authorization") ?? "" });
    return Promise.resolve(
      new Response(
        `<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>`,
        { status: 403, headers: { "content-type": "application/xml" } },
      ),
    );
  });

/**
 * Services a stack would normally supply around a state store. `state()`
 * still *types* as needing the profile (the fallback branch is part of
 * its type even when the piped-in environment wins), so tests supply it
 * even though the fallback never builds here.
 */
const TestServices = Layer.mergeAll(PlatformServices, ProfileLive);

/** Drive one state op through the given store layer. */
const listThrough = <R>(layer: Layer.Layer<State, never, R>) =>
  Effect.result(
    Effect.gen(function* () {
      const state = yield* yield* State;
      return yield* state.list({ stack: "app", stage: "dev" });
    }).pipe(Effect.provide(layer)),
  );

/** Assert a captured request went to the state account, in its region. */
const expectStateAccountRequest = (request: CapturedRequest) => {
  expect(request.url).toContain(STATE_BUCKET);
  expect(request.url).toContain(`s3.${STATE_REGION}.amazonaws.com`);
  // SigV4 credential scope proves the provided credentials signed it.
  expect(request.authorization).toContain(`Credential=${STATE_ACCESS_KEY}/`);
  expect(request.authorization).toContain(`/${STATE_REGION}/s3/aws4_request`);
};

describe("AWS S3 state store environment", () => {
  it.effect(
    "signs and addresses its calls with an environment piped into `state`",
    () =>
      Effect.gen(function* () {
        const captured: CapturedRequest[] = [];

        // The headline: `AWS.state()` declares no environment requirement
        // (it must satisfy the stack's `state` slot), but an environment
        // piped in still wins over the profile default.
        const store = yield* listThrough(
          s3StateStore({ bucketName: STATE_BUCKET }).pipe(
            Layer.provide(stateAccountEnvironment),
            Layer.provide(capturingHttpClient(captured)),
          ),
        );

        // The stub denies everything, so the op fails — what matters is
        // which account/region/credentials it failed against.
        expect(Result.isFailure(store)).toBe(true);
        expect(captured.length).toBeGreaterThan(0);
        expectStateAccountRequest(captured[0]!);
      }).pipe(Effect.provide(TestServices)),
    { timeout: 30_000 },
  );

  it.effect("`s3State` takes the environment as a hard requirement", () =>
    Effect.gen(function* () {
      const captured: CapturedRequest[] = [];

      const store = yield* listThrough(
        s3State({ bucketName: STATE_BUCKET }).pipe(
          Layer.provide(stateAccountEnvironment),
          Layer.provide(capturingHttpClient(captured)),
        ),
      );

      expect(Result.isFailure(store)).toBe(true);
      expect(captured.length).toBeGreaterThan(0);
      expectStateAccountRequest(captured[0]!);
    }),
  );

  it.effect("keeps the piped-in environment private to the state store", () =>
    Effect.gen(function* () {
      // Mirrors how `Alchemy.Stack` composes the two layers:
      // `providers.pipe(Layer.provideMerge(state))`. The state store reads
      // the environment but never merges one out, so a providers-shaped
      // layer built on top of it does not inherit the state account.
      const composed = ProvidersProbe.layer.pipe(
        Layer.provideMerge(
          s3StateStore({ bucketName: STATE_BUCKET }).pipe(
            Layer.provide(stateAccountEnvironment),
          ),
        ),
      );

      const probe = yield* Effect.provide(ProvidersProbe, composed);
      expect(probe.sawEnvironment).toBe(false);
    }).pipe(Effect.provide(TestServices)),
  );
});

/**
 * Stands in for the `providers` layer: records whether an
 * {@link AWSEnvironment} was visible in the context it was built with.
 */
class ProvidersProbe extends Context.Service<
  ProvidersProbe,
  { readonly sawEnvironment: boolean }
>()("test/ProvidersProbe") {
  static readonly layer = Layer.effect(
    ProvidersProbe,
    Effect.map(Effect.serviceOption(AWSEnvironment), (environment) => ({
      sawEnvironment: Option.isSome(environment),
    })),
  );
}

describe("Cloudflare state store environment", () => {
  it.effect("resolves the account and token it was given", () =>
    Effect.gen(function* () {
      const environment =
        yield* yield* CloudflareEnvironment.CloudflareEnvironment;
      expect(environment.accountId).toBe("cf-state-account");
      expect(environment.type).toBe("apiToken");

      const credentials = yield* yield* CloudflareCredentials.Credentials;
      expect(credentials.type).toBe("apiToken");
      if (credentials.type === "apiToken") {
        expect(Redacted.value(credentials.apiToken)).toBe("cf-state-token");
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          CloudflareEnvironment.ofApiToken({
            accountId: "cf-state-account",
            apiToken: "cf-state-token",
          }),
          CloudflareCredentials.fromApiToken({ apiToken: "cf-state-token" }),
        ),
      ),
    ),
  );

  it.effect("is not resolved from the profile when overridden", () =>
    Effect.gen(function* () {
      // No profile, no credential store, no auth provider in context: if
      // the override did not take, building this layer would demand them.
      const environment =
        yield* yield* CloudflareEnvironment.CloudflareEnvironment;
      expect(environment.accountId).toBe("cf-state-account");
      expect(yield* Effect.serviceOption(CredentialsStore)).toEqual(
        Option.none(),
      );
    }).pipe(
      Effect.provide(
        CloudflareEnvironment.ofApiToken({
          accountId: "cf-state-account",
          apiToken: "cf-state-token",
        }),
      ),
    ),
  );
});
