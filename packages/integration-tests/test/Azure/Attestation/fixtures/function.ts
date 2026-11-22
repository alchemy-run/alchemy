import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

/** The SGX policy `/set-policy` installs. */
export const POLICY =
  'version= 1.0;authorizationrules{=> permit();};issuancerules{c:[type=="x-ms-sgx-mrsigner"] => issue(type="alchemy-signer", value=c.value);};';

/** The bound attestation provider (`AAD` trust model). */
export const AttestProvider = Azure.Attestation.Provider("AttestBindingsProvider", {});

const b64url = (text: string) => Buffer.from(text).toString("base64url");

/** An unsigned JWS, the `body` an `AAD` provider takes for policy changes. */
export const unsignedJws = (payload: object | undefined) =>
  `${b64url(JSON.stringify({ alg: "none" }))}.${payload === undefined ? "" : b64url(JSON.stringify(payload))}.`;

/** The payload claims of a JWT. */
export const claimsOf = (token: string | undefined): Record<string, any> =>
  JSON.parse(Buffer.from((token ?? "").split(".")[1] ?? "", "base64url").toString("utf8"));

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/** The `_tag` an effect fails with (`"none"` when it succeeds). */
const failureTag = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.as("none"),
    Effect.catch((error) => Effect.succeed(error._tag)),
  );

/** Evidence no TEE produced: the provider must reject it. */
const GARBAGE = b64url("not-evidence");

/**
 * Effect-native Azure Function exercising every Azure Attestation binding
 * on a managed-identity host, one route per binding. Routes answer
 * `{ ok, result | error }` with a 500 on error, so a caller retries through
 * the cold start and role propagation.
 */
export default class AttestFunction extends Azure.Functions.Function<AttestFunction>()(
  "AttestBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const provider = yield* AttestProvider;
    const A = Azure.Attestation;
    const getPolicy = yield* A.GetPolicy(provider);
    const setPolicy = yield* A.SetPolicy(provider);
    const resetPolicy = yield* A.ResetPolicy(provider);
    const getPolicyCertificate = yield* A.GetPolicyCertificate(provider);
    const addPolicyCertificate = yield* A.AddPolicyCertificate(provider);
    const removePolicyCertificate = yield* A.RemovePolicyCertificate(provider);
    const getTcbBaseline = yield* A.GetTcbBaseline(provider);
    const getSigningCertificate = yield* A.GetSigningCertificate(provider);
    const getMetadataConfiguration = yield* A.GetMetadataConfiguration(provider);
    const attestSgxEnclave = yield* A.AttestSgxEnclave(provider);
    const attestOpenEnclave = yield* A.AttestOpenEnclave(provider);
    const attestSevSnpVm = yield* A.AttestSevSnpVm(provider);
    const attestTdxVm = yield* A.AttestTdxVm(provider);
    const attestTpm = yield* A.AttestTpm(provider);
    const attestAzureGuest = yield* A.AttestAzureGuest(provider);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        switch (url.pathname) {
          case "/policy":
            return yield* respond(
              Effect.map(getPolicy({ attestationType: "SgxEnclave" }), (r) => r.token),
            );
          case "/set-policy":
            return yield* respond(
              Effect.map(
                setPolicy({
                  attestationType: "SgxEnclave",
                  body: unsignedJws({ AttestationPolicy: b64url(POLICY) }),
                }),
                (r) => claimsOf(r.token)["x-ms-policy-result"],
              ),
            );
          case "/reset-policy":
            return yield* respond(
              Effect.map(
                resetPolicy({ attestationType: "SgxEnclave", body: unsignedJws(undefined) }),
                (r) => claimsOf(r.token)["x-ms-policy-result"],
              ),
            );
          case "/policy-certificates":
            return yield* respond(
              Effect.map(
                getPolicyCertificate(),
                (r) => claimsOf(r.token)["x-ms-policy-certificates"],
              ),
            );
          case "/policy-certificate-changes":
            return yield* respond(
              Effect.gen(function* () {
                // An `AAD` provider has no policy management certificates.
                const add = yield* failureTag(
                  addPolicyCertificate({ policyCertificateToAdd: unsignedJws({}) }),
                );
                const remove = yield* failureTag(
                  removePolicyCertificate({ policyCertificateToRemove: unsignedJws({}) }),
                );
                return { add, remove };
              }),
            );
          case "/tcb":
            return yield* respond(
              Effect.map(getTcbBaseline({ attestationType: "SgxEnclave" }), (r) =>
                (r.tcbBaselines ?? []).map((baseline) => baseline.tcbIdentifier),
              ),
            );
          case "/certs":
            return yield* respond(
              Effect.map(getSigningCertificate(), (set) => (set.keys ?? []).map((key) => key.kid)),
            );
          case "/metadata":
            return yield* respond(getMetadataConfiguration());
          case "/attest":
            return yield* respond(
              Effect.gen(function* () {
                return {
                  sgx: yield* failureTag(attestSgxEnclave({ quote: GARBAGE })),
                  openEnclave: yield* failureTag(attestOpenEnclave({ report: GARBAGE })),
                  sevSnp: yield* failureTag(attestSevSnpVm({ report: GARBAGE })),
                  tdx: yield* failureTag(attestTdxVm({ quote: GARBAGE })),
                  tpm: yield* failureTag(attestTpm({ data: b64url("{}") })),
                  azureGuest: yield* failureTag(attestAzureGuest({ attestationInfo: GARBAGE })),
                };
              }),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.Attestation.GetPolicyHttp,
        Azure.Attestation.SetPolicyHttp,
        Azure.Attestation.ResetPolicyHttp,
        Azure.Attestation.GetPolicyCertificateHttp,
        Azure.Attestation.AddPolicyCertificateHttp,
        Azure.Attestation.RemovePolicyCertificateHttp,
        Azure.Attestation.GetTcbBaselineHttp,
        Azure.Attestation.GetSigningCertificateHttp,
        Azure.Attestation.GetMetadataConfigurationHttp,
        Azure.Attestation.AttestSgxEnclaveHttp,
        Azure.Attestation.AttestOpenEnclaveHttp,
        Azure.Attestation.AttestSevSnpVmHttp,
        Azure.Attestation.AttestTdxVmHttp,
        Azure.Attestation.AttestTpmHttp,
        Azure.Attestation.AttestAzureGuestHttp,
      ),
    ),
  ),
) {}
