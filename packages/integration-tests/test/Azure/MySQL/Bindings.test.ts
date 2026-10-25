import * as Azure from "@alchemy.run/azure";
import type { ArmResourceId } from "@alchemy.run/azure/internal/ArmActionBinding";
import * as mysql from "@distilled.cloud/azure/mysql";
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
import MySQLFunction, { Server } from "./fixtures/function.ts";
import { serverRef, tags, untilGone } from "./server.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureMySQLBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* MySQLFunction;
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

// A General Purpose D2ads_v5 server with a zone-redundant standby
// (~$0.35/hour for both) stopped, started, restarted and failed over (each
// 2-10 min) plus a Flex Consumption app: ~$0.30/run but ~45 min, so the
// suite runs only with AZURE_TEST_EXPENSIVE=1 (as the FlexibleServer suite
// does).
const stack = runExpensive ? beforeAll(deploy(Stack), { timeout: 2_700_000 }) : undefined;

const url = Effect.suspend(() => Effect.map(stack!, (outputs) => outputs.url));

const observeServer = Effect.gen(function* () {
  const { resourceGroup, serverName } = yield* stack!;
  const ref = yield* serverRef(resourceGroup, serverName);
  return yield* mysql.GetServer(ref);
}).pipe(Effect.provide(azure));

/** The server's `state`, polled until it is `state`. */
const untilState = (state: string) =>
  observeServer.pipe(
    Effect.map((server) => server.properties?.state),
    Effect.repeat({
      schedule: Schedule.spaced("15 seconds"),
      until: (observed) => observed === state,
      times: 40,
    }),
  );

const serverOf = (id: ArmResourceId) => ({
  subscriptionId: id.subscriptionId,
  resourceGroupName: id.resourceGroupName,
  serverName: id.name("flexibleServers"),
});

// Ungated: each binding's request, with the identifiers it derives from the
// bound server's ARM ID, reaches ARM's route for the action.
describe("MySQL runtime-action requests", { tags }, () => {
  for (const [binding, send] of [
    ["StopServer", (id: ArmResourceId) => mysql.StopServer(serverOf(id))],
    ["StartServer", (id: ArmResourceId) => mysql.StartServer(serverOf(id))],
    ["RestartServer", (id: ArmResourceId) => mysql.RestartServer(serverOf(id))],
    ["FailoverServer", (id: ArmResourceId) => mysql.ServersFailover(serverOf(id))],
  ] as const) {
    test(
      `MySQL.${binding} addresses the bound server`,
      Effect.gen(function* () {
        const tag = yield* probe("Microsoft.DBforMySQL/flexibleServers/mysql-probe", send);
        expect(tag).toEqual("ResourceGroupNotFound");
      }),
    );
  }
});

// Every binding acts on one server: run them in order.
describe.skipIf(!runExpensive).sequential("MySQL bindings on an Azure Function", { tags }, () => {
  describe("MySQL.StopServer", () => {
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

  describe("MySQL.StartServer", () => {
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

  describe("MySQL.RestartServer", () => {
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

  describe("MySQL.FailoverServer", () => {
    test(
      "swaps the bound server's primary and standby zones",
      Effect.gen(function* () {
        const before = yield* observeServer;
        const primaryZone = before.properties?.availabilityZone;
        const standbyZone = before.properties?.highAvailability?.standbyAvailabilityZone;
        expect(primaryZone === standbyZone).toEqual(false);
        const body = yield* call(url, "/failover");
        expectOk(body);
        const after = yield* observeServer.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("15 seconds"),
            until: (server) =>
              server.properties?.state === "Ready" &&
              server.properties?.availabilityZone === standbyZone,
            times: 40,
          }),
        );
        expect({
          primary: after.properties?.availabilityZone,
          standby: after.properties?.highAvailability?.standbyAvailabilityZone,
        }).toEqual({ primary: standbyZone, standby: primaryZone });
      }),
      { timeout: 900_000 },
    );
  });

  describe("AzureBindings.Bind least privilege", () => {
    test(
      "assigns exactly each binding's action on the server only",
      Effect.gen(function* () {
        const outputs = yield* stack!;
        const grants = yield* awaitGrants(outputs.principalId!, outputs.hostStorageAccount, 4);
        const server = outputs.serverId.toLowerCase();
        expect(grants).toEqual(
          ["failover", "restart", "start", "stop"].map(
            (verb) => `Microsoft.DBforMySQL/flexibleServers/${verb}/action ${server}`,
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
      expect(yield* untilGone(mysql.GetServer(ref))).toEqual("gone");
    }).pipe(Effect.provide(azure)),
    { timeout: 1_800_000 },
  );
}
