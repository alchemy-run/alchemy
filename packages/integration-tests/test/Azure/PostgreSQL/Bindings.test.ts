import * as Azure from "@alchemy.run/azure";
import type { ArmResourceId } from "@alchemy.run/azure/internal/ArmActionBinding";
import * as postgresql from "@distilled.cloud/azure/postgresql";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  awaitGrants,
  awaitNoGrants,
  azure,
  call,
  expectOk,
  probe,
} from "../arm-action-bindings.ts";
import { runExpensive } from "../gates.ts";
import PostgreSQLFunction, { Server } from "./fixtures/function.ts";
import { serverRef, tags, untilGone } from "./server.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzurePostgreSQLBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* PostgreSQLFunction;
    const server = yield* Server;
    return {
      url: fn.url,
      principalId: fn.principalId,
      hostStorageAccount: fn.storageAccountName,
      resourceGroup: server.resourceGroup,
      serverName: server.serverName,
      serverId: server.serverId,
    };
  }),
);

// A Burstable B1ms flexible server (~$0.02/hour) stopped, started and
// restarted (each 2-5 min) plus a Flex Consumption app: ~$0.02/run, but
// ~25 min, so the suite runs only with AZURE_TEST_EXPENSIVE=1 (as the
// FlexibleServer suite does).
const stack = runExpensive ? beforeAll(deploy(Stack), { timeout: 1_800_000 }) : undefined;

const url = Effect.suspend(() => Effect.map(stack!, (outputs) => outputs.url));

/** The server's `state`, polled until it is `state`. */
const untilState = (state: string) =>
  Effect.gen(function* () {
    const { resourceGroup, serverName } = yield* stack!;
    const ref = yield* serverRef(resourceGroup, serverName);
    return yield* postgresql.GetServer(ref).pipe(
      Effect.map((server) => server.properties?.state),
      Effect.repeat({
        schedule: Schedule.spaced("15 seconds"),
        until: (observed) => observed === state,
        times: 40,
      }),
    );
  }).pipe(Effect.provide(azure));

// Ungated: each binding's request, with the identifiers it derives from the
// bound server's ARM ID, reaches ARM's route for the action.
const serverOf = (id: ArmResourceId) => ({
  subscriptionId: id.subscriptionId,
  resourceGroupName: id.resourceGroupName,
  serverName: id.name("flexibleServers"),
});

describe("PostgreSQL runtime-action requests", { tags }, () => {
  for (const [binding, send] of [
    ["StopServer", (id: ArmResourceId) => postgresql.StopServer(serverOf(id))],
    ["StartServer", (id: ArmResourceId) => postgresql.StartServer(serverOf(id))],
    ["RestartServer", (id: ArmResourceId) => postgresql.RestartServer(serverOf(id))],
  ] as const) {
    test(
      `PostgreSQL.${binding} addresses the bound server`,
      Effect.gen(function* () {
        const tag = yield* probe("Microsoft.DBforPostgreSQL/flexibleServers/pg-probe", send);
        expect(tag).toEqual("ResourceGroupNotFound");
      }),
    );
  }
});

// Stop, start and restart act on one server: run them in order.
describe
  .skipIf(!runExpensive)
  .sequential("PostgreSQL bindings on an Azure Function", { tags }, () => {
    describe("PostgreSQL.StopServer", () => {
      test(
        "stops the bound server",
        Effect.gen(function* () {
          const body = yield* call(url, "/stop");
          expectOk(body);
          expect(yield* untilState("Stopped")).toEqual("Stopped");
        }),
        { timeout: 900_000 },
      );
    });

    describe("PostgreSQL.StartServer", () => {
      test(
        "starts the bound server",
        Effect.gen(function* () {
          const body = yield* call(url, "/start");
          expectOk(body);
          expect(yield* untilState("Ready")).toEqual("Ready");
        }),
        { timeout: 900_000 },
      );
    });

    describe("PostgreSQL.RestartServer", () => {
      test(
        "restarts the bound server",
        Effect.gen(function* () {
          const body = yield* call(url, "/restart");
          expectOk(body);
          expect(yield* untilState("Ready")).toEqual("Ready");
        }),
        { timeout: 900_000 },
      );
    });

    describe("AzureBindings.Bind least privilege", () => {
      test(
        "assigns exactly each binding's action on the server only",
        Effect.gen(function* () {
          const outputs = yield* stack!;
          const grants = yield* awaitGrants(outputs.principalId!, outputs.hostStorageAccount, 3);
          const server = outputs.serverId.toLowerCase();
          expect(grants).toEqual(
            ["restart", "start", "stop"].map(
              (verb) => `Microsoft.DBforPostgreSQL/flexibleServers/${verb}/action ${server}`,
            ),
          );
        }),
        { timeout: 300_000 },
      );
    });
  });

if (runExpensive) {
  // Destroy, then prove the server and every role on the Function's identity are gone.
  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const { principalId, hostStorageAccount, resourceGroup, serverName } = yield* stack!;
      yield* destroy(Stack);
      expect(yield* awaitNoGrants(principalId!, hostStorageAccount)).toEqual([]);
      const ref = yield* serverRef(resourceGroup, serverName);
      expect(yield* untilGone(postgresql.GetServer(ref))).toEqual("gone");
    }).pipe(Effect.provide(azure)),
    { timeout: 1_800_000 },
  );
}
