import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

/**
 * The account holding the identity validation lives outside the stack
 * (deleting it would discard the validation). The test passes it through
 * these env vars, which the Function also gets as app settings so its
 * runtime binds the same endpoint.
 */
export const SIGNING_ENV = {
  accountUri: "AZURE_TEST_CODESIGNING_ACCOUNT_URI",
  accountName: "AZURE_TEST_CODESIGNING_ACCOUNT_NAME",
  resourceGroup: "AZURE_TEST_CODESIGNING_RESOURCE_GROUP",
  identityValidationId: "AZURE_TEST_CODESIGNING_IDENTITY_VALIDATION_ID",
} as const;

const env = (name: string) => process.env[name] ?? "";

/** The profile the Function signs with, on the external account. */
export const SigningProfile = Azure.CodeSigning.CertificateProfile(
  "BindingsProfile",
  Effect.sync(() => ({
    resourceGroup: env(SIGNING_ENV.resourceGroup),
    account: env(SIGNING_ENV.accountName),
    profileType: "PublicTrustTest" as const,
    identityValidationId: env(SIGNING_ENV.identityValidationId),
  })),
);

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Effect-native Azure Function exercising every Artifact Signing binding on
 * a managed-identity host, one route per binding.
 */
export default class SigningFunction extends Azure.Functions.Function<SigningFunction>()(
  "SigningBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
    env: { [SIGNING_ENV.accountUri]: env(SIGNING_ENV.accountUri) },
  },
  Effect.gen(function* () {
    const profile = yield* SigningProfile;
    const account = env(SIGNING_ENV.accountUri);
    const CS = Azure.CodeSigning;
    const sign = yield* CS.Sign(account, profile);
    const getSigningStatus = yield* CS.GetSigningStatus(account, profile);
    const getSignCertificateChain = yield* CS.GetSignCertificateChain(account, profile);
    const getSignRootCertificate = yield* CS.GetSignRootCertificate(account, profile);
    const listExtendedKeyUsages = yield* CS.ListExtendedKeyUsages(account, profile);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        switch (url.pathname) {
          case "/sign":
            return yield* respond(
              Effect.gen(function* () {
                const digest = url.searchParams.get("digest") ?? "";
                const started = yield* sign({ signatureAlgorithm: "PS256", digest });
                const operationId = (started.operationLocation ?? "").split("/").pop() ?? "";
                const status = yield* getSigningStatus({ operationId }).pipe(
                  Effect.repeat({
                    schedule: Schedule.spaced("2 seconds"),
                    until: (s) => s.status !== "NotStarted" && s.status !== "Running",
                    times: 15,
                  }),
                );
                return {
                  operationId,
                  status: status.status,
                  signed: (status.result?.signature ?? "").length > 0,
                };
              }),
            );
          case "/chain":
            return yield* respond(
              Effect.map(getSignCertificateChain(), (chain) => String(chain).length > 0),
            );
          case "/root":
            return yield* respond(
              Effect.map(getSignRootCertificate(), (root) => String(root).length > 0),
            );
          case "/ekus":
            return yield* respond(
              Effect.map(listExtendedKeyUsages(), (ekus) => ekus.map((eku) => eku.eku)),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.CodeSigning.SignHttp,
        Azure.CodeSigning.GetSigningStatusHttp,
        Azure.CodeSigning.GetSignCertificateChainHttp,
        Azure.CodeSigning.GetSignRootCertificateHttp,
        Azure.CodeSigning.ListExtendedKeyUsagesHttp,
      ),
    ),
  ),
) {}
