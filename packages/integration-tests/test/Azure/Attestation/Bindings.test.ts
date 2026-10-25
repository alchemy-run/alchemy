import * as Azure from "@alchemy.run/azure";
import * as attestation from "@distilled.cloud/azure/attestation";
import * as att from "@distilled.cloud/azure/attestation-data";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import AttestFunction, { AttestProvider, POLICY, claimsOf } from "./fixtures/function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureAttestationBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* AttestFunction;
    const provider = yield* AttestProvider;
    return {
      url: fn.url,
      principalId: fn.principalId,
      attestUri: provider.attestUri,
      providerId: provider.providerId,
      providerName: provider.providerName,
      resourceGroup: provider.resourceGroup,
    };
  }),
);

// Attestation providers are free; Flex Consumption ~$0.01/run; ~5 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

/** Deployer credentials and environment for out-of-band checks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and role propagation (about 4 minutes), then return the last
 * answer so a real failure shows its Azure error.
 */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.execute(HttpClientRequest.get(`${url}${route}`)).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((json) => json as Body),
      Effect.flatMap((json) => (json?.ok ? Effect.succeed(json) : Effect.fail(json))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
      Effect.catch((json) => Effect.succeed(json as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** The SGX policy text inside a GetPolicy token (`x-ms-policy` is a JWS of `AttestationPolicy`). */
const policyText = (token: string | undefined) =>
  Buffer.from(claimsOf(claimsOf(token)["x-ms-policy"]).AttestationPolicy, "base64url").toString(
    "utf8",
  );

/** The SGX policy as the deployer reads it. */
const deployerPolicy = Effect.gen(function* () {
  const { attestUri } = yield* stack;
  const policy = yield* att.GetPolicy({ endpoint: attestUri, attestationType: "SgxEnclave" });
  return policyText(policy.token);
}).pipe(Effect.provide(azure));

/** Role assignments of the Function's identity, without its own host-storage grants. */
const assignmentsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const assignments = yield* Stream.runCollect(
      authorization.ListRoleAssignmentForSubscription.items({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      }),
    );
    return Array.from(assignments).filter(
      (a) => !/\/storageaccounts\/[^/]+$/.test(a.properties?.scope?.toLowerCase() ?? ""),
    );
  }).pipe(Effect.provide(azure));

/** Every role on the Function's identity as `<actions> <scope>`. */
const grantsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const grants: string[] = [];
    for (const assignment of yield* assignmentsOf(principalId)) {
      const definition = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId: assignment.properties?.roleDefinitionId?.split("/").pop() ?? "",
      });
      const actions = (definition.properties?.permissions ?? [])
        .flatMap((p) => [...(p.actions ?? []), ...(p.dataActions ?? [])])
        .sort()
        .join("+");
      grants.push(`${actions} ${assignment.properties?.scope?.toLowerCase() ?? ""}`);
    }
    return grants.sort();
  }).pipe(Effect.provide(azure));

describe(
  "Azure Attestation data-plane bindings on an Azure Function",
  { tags: ["provider:azure", "provider:azure:attestation", "live"] },
  () => {
    describe("Attestation grants", () => {
      test(
        "assigns exactly the read and write policy actions, on the provider only",
        Effect.gen(function* () {
          const { principalId, providerId } = yield* stack;
          expectOk(yield* call("/metadata"));
          const scope = providerId.toLowerCase();
          expect(yield* grantsOf(principalId ?? "")).toEqual([
            `Microsoft.Attestation/attestationProviders/attestation/read ${scope}`,
            `Microsoft.Attestation/attestationProviders/attestation/write ${scope}`,
          ]);
        }),
        { timeout: 300_000 },
      );
    });

    describe("Attestation.SetPolicy / GetPolicy / ResetPolicy", () => {
      test(
        "sets the SGX policy, reads it back, and resets it to the default",
        Effect.gen(function* () {
          const before = yield* deployerPolicy;
          expect(before).not.toEqual(POLICY);

          const set = yield* call("/set-policy");
          expectOk(set);
          expect(set.result).toEqual("Updated");
          expect(yield* deployerPolicy).toEqual(POLICY);

          const read = yield* call("/policy");
          expectOk(read);
          expect(policyText(read.result)).toEqual(POLICY);

          const reset = yield* call("/reset-policy");
          expectOk(reset);
          expect(reset.result).toEqual("Removed");
          expect(yield* deployerPolicy).toEqual(before);
        }),
        { timeout: 300_000 },
      );
    });

    describe("Attestation.GetPolicyCertificate", () => {
      test(
        "an AAD provider has no policy management certificates",
        Effect.gen(function* () {
          const body = yield* call("/policy-certificates");
          expectOk(body);
          expect(body.result).toEqual({ keys: [] });
        }),
        { timeout: 300_000 },
      );
    });

    describe("Attestation.AddPolicyCertificate / RemovePolicyCertificate", () => {
      test(
        "an AAD provider rejects policy certificate changes",
        Effect.gen(function* () {
          const body = yield* call("/policy-certificate-changes");
          expectOk(body);
          expect(body.result).toEqual({ add: "InvalidParameter", remove: "InvalidParameter" });
        }),
        { timeout: 300_000 },
      );
    });

    describe("Attestation.GetTcbBaseline", () => {
      test(
        "lists the SGX TCB baselines the deployer sees",
        Effect.gen(function* () {
          const { attestUri } = yield* stack;
          const body = yield* call("/tcb");
          expectOk(body);
          const expected = yield* att
            .GetTcbBaseline({ endpoint: attestUri, attestationType: "SgxEnclave" })
            .pipe(Effect.provide(azure));
          expect(body.result).toEqual(
            (expected.tcbBaselines ?? []).map((baseline) => baseline.tcbIdentifier),
          );
          expect(body.result.length).toBeGreaterThan(0);
        }),
        { timeout: 300_000 },
      );
    });

    describe("Attestation.GetSigningCertificate", () => {
      test(
        "returns the token signing keys the deployer sees",
        Effect.gen(function* () {
          const { attestUri } = yield* stack;
          const body = yield* call("/certs");
          expectOk(body);
          const expected = yield* att
            .GetSigningCertificate({ endpoint: attestUri })
            .pipe(Effect.provide(azure));
          expect(body.result).toEqual((expected.keys ?? []).map((key) => key.kid));
          expect(body.result.length).toBeGreaterThan(0);
        }),
        { timeout: 300_000 },
      );
    });

    describe("Attestation.GetMetadataConfiguration", () => {
      test(
        "returns the provider's OpenID metadata",
        Effect.gen(function* () {
          const { attestUri } = yield* stack;
          const body = yield* call("/metadata");
          expectOk(body);
          expect(body.result.issuer).toEqual(attestUri);
          expect(body.result.jwks_uri).toEqual(`${attestUri}/certs`);
        }),
        { timeout: 300_000 },
      );
    });

    describe("Attestation.Attest*", () => {
      test(
        "every attest binding reaches the provider, which rejects evidence no TEE produced",
        Effect.gen(function* () {
          const body = yield* call("/attest");
          expectOk(body);
          expect(body.result).toEqual({
            sgx: "BadRequest",
            openEnclave: "BadRequest",
            sevSnp: "BadRequest",
            tdx: "BadRequest",
            tpm: "BadRequest",
            azureGuest: "BadRequest",
          });
        }),
        { timeout: 300_000 },
      );
    });
  },
);

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { principalId, providerName, resourceGroup } = yield* stack;
    yield* destroy(Stack);
    const { subscriptionId } = yield* Azure.AzureEnvironment.current.pipe(Effect.provide(azure));
    const gone = yield* attestation
      .GetAttestationProvider({ subscriptionId, resourceGroupName: resourceGroup, providerName })
      .pipe(
        Effect.as("found" as const),
        Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound", "NotFound"], () =>
          Effect.succeed("gone" as const),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (status) => status === "gone",
          times: 24,
        }),
        Effect.provide(azure),
      );
    expect(gone).toEqual("gone");
    // The role-assignment list trails deletes by up to a minute.
    const remaining = yield* assignmentsOf(principalId ?? "").pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 seconds"),
        until: (assignments) => assignments.length === 0,
        times: 12,
      }),
    );
    expect(remaining).toEqual([]);
  }),
  { timeout: 900_000 },
);
