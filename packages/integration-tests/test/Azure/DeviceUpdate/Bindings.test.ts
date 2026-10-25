import * as Azure from "@alchemy.run/azure";
import { Credentials, type Config } from "@distilled.cloud/azure";
import * as adu from "@distilled.cloud/azure/deviceupdate-data";
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
import { runExpensive } from "../gates.ts";
import DuFunction, { Fleet } from "./fixtures/function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

describe("Device Update request encoding", { tags: ["provider:azure"] }, () => {
  /** Capture the one request an operation sends, with a token per audience. */
  const captured = <A, E>(
    operation: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
    body = "{}",
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

  const endpoint = "fleet.api.adu.microsoft.com";

  test(
    "ListUpdates reads the instance's update catalog with a Device Update token",
    Effect.gen(function* () {
      const { calls } = yield* captured(
        adu.ListDeviceUpdateUpdates({ endpoint, instanceId: "blue" }),
        '{"value":[]}',
      );
      expect(calls.map(({ method, url, auth }) => ({ method, url, auth }))).toEqual([
        {
          method: "GET",
          url: "https://fleet.api.adu.microsoft.com/deviceUpdate/blue/updates?api-version=2026-06-01",
          auth: "Bearer aad:https://api.adu.microsoft.com/.default",
        },
      ]);
    }),
  );

  test(
    "GetUpdate addresses one update version",
    Effect.gen(function* () {
      const { calls } = yield* captured(
        adu.DeviceUpdateGetUpdate({
          endpoint,
          instanceId: "blue",
          provider: "contoso",
          name: "toaster",
          version: "1.0.0",
        }),
      );
      expect(calls.map(({ method, url }) => ({ method, url }))).toEqual([
        {
          method: "GET",
          url: "https://fleet.api.adu.microsoft.com/deviceUpdate/blue/updates/providers/contoso/names/toaster/versions/1.0.0?api-version=2026-06-01",
        },
      ]);
    }),
  );

  test(
    "CreateOrUpdateDeployment puts the deployment under its group",
    Effect.gen(function* () {
      const { calls } = yield* captured(
        adu.DeviceManagementCreateOrUpdateDeployment({
          endpoint,
          instanceId: "blue",
          groupId: "lobby",
          deploymentId: "rollout-1",
          startDateTime: "2026-01-01T00:00:00Z",
          update: { updateId: { provider: "contoso", name: "toaster", version: "1.0.0" } },
        }),
      );
      expect(calls.map(({ method, url }) => ({ method, url }))).toEqual([
        {
          method: "PUT",
          url: "https://fleet.api.adu.microsoft.com/deviceUpdate/blue/management/groups/lobby/deployments/rollout-1?api-version=2026-06-01",
        },
      ]);
      expect(JSON.parse(calls[0]?.body ?? "{}").update).toEqual({
        updateId: { provider: "contoso", name: "toaster", version: "1.0.0" },
      });
    }),
  );

  test(
    "DeleteGroup deletes the group",
    Effect.gen(function* () {
      const { calls } = yield* captured(
        adu.DeleteDeviceManagementGroup({ endpoint, instanceId: "blue", groupId: "lobby" }),
      );
      expect(calls.map(({ method, url }) => ({ method, url }))).toEqual([
        {
          method: "DELETE",
          url: "https://fleet.api.adu.microsoft.com/deviceUpdate/blue/management/groups/lobby?api-version=2026-06-01",
        },
      ]);
    }),
  );
});

const Stack = Alchemy.Stack(
  "AzureDeviceUpdateBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* DuFunction;
    const fleet = yield* Fleet;
    return { url: fn.url, instanceId: fleet.instanceId };
  }),
);

// Standard Device Update account (~$0.27/hour) + S1 IoT hub (~$0.034/hour)
// + Flex Consumption: about $0.20 per run, but the instance stays `Creating`
// for over 10 minutes (observed >20), so the suite allows an hour.
const stack = runExpensive ? beforeAll(deploy(Stack), { timeout: 3_600_000 }) : undefined;

type Body = { ok: boolean; result?: any; error?: string };

/** Call a binding route until it answers `ok` (cold start, role propagation). */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack!;
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

describe.skipIf(!runExpensive)(
  "Device Update bindings on an Azure Function",
  { tags: ["provider:azure", "provider:azure:deviceupdate", "live"] },
  () => {
    for (const [binding, route] of [
      ["ListUpdates", "/updates"],
      ["ListUpdateProviders", "/providers"],
      ["ListGroups", "/groups"],
      ["ListDevices", "/devices"],
      ["ListDeviceClasses", "/device-classes"],
    ] as const) {
      describe(`DeviceUpdate.${binding}`, () => {
        test(
          "answers an empty page on a new instance",
          Effect.gen(function* () {
            const body = yield* call(route);
            expectOk(body);
            expect(body.result).toEqual(0);
          }),
          { timeout: 300_000 },
        );
      });
    }

    describe("DeviceUpdate.GetUpdateCompliance", () => {
      test(
        "counts no devices on a new instance",
        Effect.gen(function* () {
          const body = yield* call("/compliance");
          expectOk(body);
          expect(body.result).toEqual(0);
        }),
        { timeout: 300_000 },
      );
    });
  },
);

if (runExpensive) {
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 3_600_000 });
}
