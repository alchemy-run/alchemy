import * as Azure from "@alchemy.run/azure";
import { Credentials, type Config } from "@distilled.cloud/azure";
import * as sign from "@distilled.cloud/azure/artifactsigning-data";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";
import SigningFunction, { SIGNING_ENV, SigningProfile } from "./fixtures/function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/**
 * Signing needs a certificate profile, which needs a paid subscription, an
 * account ($9.99+/month) and an identity validation completed in the portal
 * (days of manual review). Supply them through these env vars.
 */
const live =
  runPaidOnly && Object.values(SIGNING_ENV).every((name) => process.env[name] !== undefined);

describe("Artifact Signing request encoding", { tags: ["provider:azure"] }, () => {
  /** Capture the one request an operation sends, with a token per audience. */
  const captured = <A, E>(operation: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>) =>
    Effect.gen(function* () {
      const calls: { method: string; url: string; auth?: string; body?: string }[] = [];
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request, url) =>
          Effect.sync(() => {
            calls.push({
              method: request.method,
              url: url.href,
              auth: request.headers.authorization,
              body:
                request.body._tag === "Uint8Array"
                  ? new TextDecoder().decode(request.body.body)
                  : undefined,
            });
            return HttpClientResponse.fromWeb(
              request,
              new Response("{}", {
                status: 202,
                headers: { "operation-location": "https://eus.codesigning.azure.net/op/1" },
              }),
            );
          }),
        ),
      );
      const credentials = Layer.succeed(
        Credentials,
        Effect.succeed<Config>({
          bearerToken: Redacted.make("arm-token"),
          subscriptionId: "00000000-0000-0000-0000-000000000001",
          apiBaseUrl: "https://management.azure.com",
          tokenFor: (scope: string) => Effect.succeed(Redacted.make(`aad:${scope}`)),
        }),
      );
      const result = yield* operation.pipe(
        Effect.provide(credentials),
        Effect.provide(http),
        Effect.result,
      );
      return { calls, result };
    });

  test(
    "Sign posts the digest to the profile's :sign endpoint with a codesigning token",
    Effect.gen(function* () {
      const { calls } = yield* captured(
        sign.SignCertificateProfileOperation({
          endpoint: "https://eus.codesigning.azure.net",
          accountName: "acct",
          certificateProfile: "release",
          signatureAlgorithm: "PS256",
          digest: "q83vEjRWeJA=",
        }),
      );
      expect(calls.map(({ method, url, auth }) => ({ method, url, auth }))).toEqual([
        {
          method: "POST",
          url: "https://eus.codesigning.azure.net/codesigningaccounts/acct/certificateprofiles/release:sign?api-version=2024-06-15",
          auth: "Bearer aad:https://codesigning.azure.net/.default",
        },
      ]);
      expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
        signatureAlgorithm: "PS256",
        digest: "q83vEjRWeJA=",
      });
    }),
  );

  test(
    "GetSigningStatus reads the operation under the profile",
    Effect.gen(function* () {
      const { calls } = yield* captured(
        sign.GetCertificateProfileOperationSigningStatus({
          endpoint: "https://eus.codesigning.azure.net",
          accountName: "acct",
          certificateProfile: "release",
          operationId: "op-1",
        }),
      );
      expect(calls.map(({ method, url }) => ({ method, url }))).toEqual([
        {
          method: "GET",
          url: "https://eus.codesigning.azure.net/codesigningaccounts/acct/certificateprofiles/release/sign/op-1?api-version=2024-06-15",
        },
      ]);
    }),
  );
});

const Stack = Alchemy.Stack(
  "AzureCodeSigningBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* SigningFunction;
    const profile = yield* SigningProfile;
    return { url: fn.url, profileId: profile.profileId };
  }),
);

// Paid subscription with an existing account and a completed identity
// validation (portal-only). Profiles add no charge; Flex Consumption
// ~$0.01/run: ~$0 per run, ~8 minutes.
const stack = live ? beforeAll(deploy(Stack), { timeout: 900_000 }) : undefined;

type Body = { ok: boolean; result?: any; error?: string };

/** Call a binding route until it answers `ok` (cold start, role propagation). */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack!;
    return yield* HttpClient.execute(HttpClientRequest.get(`${url}${route}`)).pipe(
      Effect.timeout("90 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((json) => json as Body),
      Effect.flatMap((json) => (json?.ok ? Effect.succeed(json) : Effect.fail(json))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
      Effect.catch((json) => Effect.succeed(json as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

describe.skipIf(!live)(
  "Artifact Signing bindings on an Azure Function",
  { tags: ["provider:azure", "provider:azure:codesigning", "live"] },
  () => {
    describe("CodeSigning.Sign / GetSigningStatus", () => {
      test(
        "signs a SHA-256 digest",
        Effect.gen(function* () {
          // SHA-256 of the empty string, base64.
          const digest = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
          const body = yield* call(`/sign?digest=${encodeURIComponent(digest)}`);
          expectOk(body);
          expect(body.result.status).toEqual("Succeeded");
          expect(body.result.signed).toEqual(true);
        }),
        { timeout: 300_000 },
      );
    });

    describe("CodeSigning.GetSignCertificateChain", () => {
      test(
        "downloads the certificate chain",
        Effect.gen(function* () {
          const body = yield* call("/chain");
          expectOk(body);
          expect(body.result).toEqual(true);
        }),
        { timeout: 300_000 },
      );
    });

    describe("CodeSigning.GetSignRootCertificate", () => {
      test(
        "downloads the root certificate",
        Effect.gen(function* () {
          const body = yield* call("/root");
          expectOk(body);
          expect(body.result).toEqual(true);
        }),
        { timeout: 300_000 },
      );
    });

    describe("CodeSigning.ListExtendedKeyUsages", () => {
      test(
        "lists the code-signing EKU",
        Effect.gen(function* () {
          const body = yield* call("/ekus");
          expectOk(body);
          // Code Signing: 1.3.6.1.5.5.7.3.3.
          expect(body.result).toContain("1.3.6.1.5.5.7.3.3");
        }),
        { timeout: 300_000 },
      );
    });
  },
);

if (live) {
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 900_000 });
}
