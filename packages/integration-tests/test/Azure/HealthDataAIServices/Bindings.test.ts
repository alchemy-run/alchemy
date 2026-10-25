import * as Azure from "@alchemy.run/azure";
import { Credentials, type Config } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as deid from "@distilled.cloud/azure/healthdataaiservices-data";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import DeidBindingsFunction, { Deid, JOB, NOTE } from "./fixtures/function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

describe("De-identification request encoding", { tags: ["provider:azure"] }, () => {
  /** Capture the one request an operation sends, with a token per audience. */
  const captured = <A, E>(
    operation: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
    body: string,
  ) =>
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
            return HttpClientResponse.fromWeb(request, new Response(body, { status: 200 }));
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

  const endpoint = "https://blue.api.eus001.deid.azure.com";

  test(
    "DeidentifyText posts the text to /deid with a de-identification token",
    Effect.gen(function* () {
      const { calls } = yield* captured(
        deid.DeidentifyText({ endpoint, inputText: "John", operation: "Tag" }),
        '{"taggerResult":{"entities":[]}}',
      );
      expect(calls.map(({ method, url, auth }) => ({ method, url, auth }))).toEqual([
        {
          method: "POST",
          url: "https://blue.api.eus001.deid.azure.com/deid?api-version=2024-11-15",
          auth: "Bearer aad:https://deid.azure.com/.default",
        },
      ]);
      expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ inputText: "John", operation: "Tag" });
    }),
  );
});

/** Built-in **DeID Batch Data Reader**: the deployer's out-of-band job reads. */
const DEID_BATCH_DATA_READER = "b73a14ee-91f5-41b7-bd81-920e12466be9";

/** Object ID (`oid` claim) of the identity running the tests. */
const callerObjectId = Effect.gen(function* () {
  const config = yield* yield* Credentials;
  const token = Redacted.value(config.bearerToken);
  return yield* Effect.sync(
    () =>
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
        .oid as string,
  );
});

const Stack = Alchemy.Stack(
  "AzureDeidBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* DeidBindingsFunction;
    const service = yield* Deid;
    // Lets the deployer read the jobs the bindings create.
    const deployer = yield* callerObjectId.pipe(Effect.orDie);
    yield* Azure.Authorization.RoleAssignment("DeidDeployerBatchReader", {
      scope: service.deidServiceId,
      roleDefinitionId: DEID_BATCH_DATA_READER,
      principalId: deployer,
    });
    return {
      url: fn.url,
      principalId: fn.principalId,
      serviceUrl: service.serviceUrl,
      deidServiceId: service.deidServiceId,
    };
  }),
);

// An idle de-identification service is free (billed per MB processed);
// Flex Consumption + storage cost cents. ~5 min deploy.
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
 * cold start and role propagation, then return the last answer so a real
 * failure shows its Azure error.
 */
const call = (route: string, times = 48) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.execute(HttpClientRequest.get(`${url}${route}`)).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((json) => json as Body),
      Effect.flatMap((json) => (json?.ok ? Effect.succeed(json) : Effect.fail(json))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times }),
      Effect.catch((json) => Effect.succeed(json as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** Run a `healthdataaiservices-data` call as the deployer against the bound service. */
const asDeployer = <A, E>(f: (endpoint: string) => Effect.Effect<A, E, any>) =>
  Effect.gen(function* () {
    const { serviceUrl } = yield* stack;
    return yield* f(serviceUrl ?? "") as Effect.Effect<A, E>;
  }).pipe(Effect.provide(azure));

/** The job as the deployer sees it, `"gone"` once deleted, retried through role propagation. */
const observedJob = asDeployer((endpoint) =>
  deid.GetJob({ endpoint, name: JOB }).pipe(
    Effect.map((job) => ({ status: job.status as string, prefix: job.sourceLocation.prefix })),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  ),
).pipe(Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 18 }));

/** Role definitions assigned to the Function's identity on the service. */
const grantsOn = (principalId: string, scope: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const assignments = yield* Stream.runCollect(
      authorization.ListRoleAssignmentForSubscription.items({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      }),
    );
    const grants: string[] = [];
    for (const assignment of assignments) {
      if (assignment.properties?.scope?.toLowerCase() !== scope.toLowerCase()) continue;
      const definition = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId: assignment.properties?.roleDefinitionId?.split("/").pop() ?? "",
      });
      grants.push(
        (definition.properties?.permissions ?? [])
          .flatMap((p) => [...(p.actions ?? []), ...(p.dataActions ?? [])])
          .map((a) => a.replace(/^Microsoft\.HealthDataAIServices\/DeidServices\//, ""))
          .sort()
          .join("+"),
      );
    }
    return grants.sort();
  }).pipe(Effect.provide(azure));

describe(
  "De-identification bindings on an Azure Function",
  { tags: ["provider:azure", "provider:azure:healthdataaiservices", "live"] },
  () => {
    describe("HealthDataAIServices.DeidentifyText", () => {
      test(
        "tags the PHI in a text",
        Effect.gen(function* () {
          const body = yield* call("/text/tag");
          expectOk(body);
          expect(body.result.categories).toContain("Patient");
          expect(body.result.categories).toContain("Hospital");
        }),
        { timeout: 400_000 },
      );

      test(
        "redacts the PHI in a text",
        Effect.gen(function* () {
          const body = yield* call("/text/redact");
          expectOk(body);
          expect(body.result.outputText).not.toContain("John Smith");
          expect(body.result.outputText).toMatch(/^Patient \S+/);
        }),
        { timeout: 300_000 },
      );
    });

    describe("HealthDataAIServices.DeidentifyDocuments", () => {
      test(
        "creates a job over the seeded document",
        Effect.gen(function* () {
          expectOk(yield* call("/seed"));
          const body = yield* call("/job/create");
          expectOk(body);
          expect(body.result).toEqual({ name: JOB, operation: "Surrogate" });
          const observed = yield* observedJob;
          expect(observed === "gone" ? observed : observed.prefix).toEqual("in/");
        }),
        { timeout: 400_000 },
      );
    });

    describe("HealthDataAIServices.GetJob", () => {
      test(
        "reads the job",
        Effect.gen(function* () {
          const body = yield* call("/job/get");
          expectOk(body);
          expect({ name: body.result.name, prefix: body.result.prefix }).toEqual({
            name: JOB,
            prefix: "in/",
          });
          const observed = yield* observedJob;
          expect(observed === "gone" ? observed : observed.prefix).toEqual("in/");
        }),
        { timeout: 300_000 },
      );
    });

    describe("HealthDataAIServices.ListJobs", () => {
      test(
        "lists the job",
        Effect.gen(function* () {
          const body = yield* call("/job/list");
          expectOk(body);
          expect(body.result.names).toContain(JOB);
        }),
        { timeout: 300_000 },
      );
    });

    describe("HealthDataAIServices.ListJobDocuments", () => {
      test(
        "lists the job's document once the job has picked it up",
        Effect.gen(function* () {
          const body = yield* call("/job/documents").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              until: (b) => (b.result?.inputs?.length ?? 0) > 0,
              times: 18,
            }),
          );
          expectOk(body);
          expect(body.result.inputs.map((p: string) => p.split("/").slice(2).join("/"))).toEqual([
            NOTE,
          ]);
        }),
        { timeout: 400_000 },
      );
    });

    describe("HealthDataAIServices.CancelJob", () => {
      test(
        "cancels the job, or leaves a finished one as it is",
        Effect.gen(function* () {
          const body = yield* call("/job/cancel");
          expectOk(body);
          expect(body.result).toEqual({ name: JOB });
          const status = yield* observedJob.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              until: (s) => s === "gone" || (s.status !== "NotStarted" && s.status !== "Running"),
              times: 18,
            }),
          );
          // A job that finished before the cancel keeps its status.
          expect(status === "gone" ? status : status.status).not.toMatch(
            /^(NotStarted|Running|gone)$/,
          );
        }),
        { timeout: 400_000 },
      );
    });

    describe("HealthDataAIServices.DeleteJob", () => {
      test(
        "deletes the job",
        Effect.gen(function* () {
          const body = yield* call("/job/delete");
          expectOk(body);
          const status = yield* observedJob.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (s) => s === "gone",
              times: 12,
            }),
          );
          expect(status).toEqual("gone");
        }),
        { timeout: 300_000 },
      );
    });

    describe("AzureBindings.Bind least privilege", () => {
      test(
        "assigns exactly one role per binding kind, on the service only",
        Effect.gen(function* () {
          const { principalId, deidServiceId } = yield* stack;
          const grants = yield* grantsOn(principalId ?? "", deidServiceId).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (found) => found.length >= 4,
              times: 12,
            }),
          );
          expect(grants).toEqual(["Batch/delete", "Batch/read", "Batch/write", "Realtime/action"]);
        }),
        { timeout: 120_000 },
      );
    });
  },
);

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 900_000 });
