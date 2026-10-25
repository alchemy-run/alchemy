import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as batch from "@distilled.cloud/azure/batch";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import BatchArmFunction, { Account } from "./fixtures/arm-function.ts";
import { tags } from "./util.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureBatchArmBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* BatchArmFunction;
    const account = yield* Account;
    return {
      url: fn.url,
      principalId: fn.principalId,
      hostStorageAccount: fn.storageAccountName,
      accountId: account.accountId,
      autoStorageId: account.autoStorageAccountId,
      accountName: account.accountName,
      resourceGroup: account.resourceGroup,
    };
  }),
);

// The Batch account is free and runs no pool; a storage account and a Flex
// Consumption app (~$0.01/run); ~5 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/** Deployer credentials and environment for out-of-band checks and hooks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: unknown; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and role propagation, then return the last answer so a real
 * failure shows its ARM error.
 */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.get(`${url}${route}`).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as Body),
      Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 60 }),
      Effect.catch((body) => Effect.succeed(body as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** When the account last synchronized its auto-storage keys (deployer credentials). */
const lastKeySync = Effect.gen(function* () {
  const { accountName, resourceGroup } = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current;
  const account = yield* batch.GetBatchAccount({
    subscriptionId,
    resourceGroupName: resourceGroup,
    accountName,
  });
  return account.properties?.autoStorage?.lastKeySync;
}).pipe(Effect.provide(azure));

/** Every role on the Function's identity as `<actions> <scope>`, without its host-storage grants. */
const grantsOf = (principalId: string, hostStorageAccount: string | undefined) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const assignments = yield* Stream.runCollect(
      authorization.ListRoleAssignmentForSubscription.items({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      }),
    );
    const host = `/storageaccounts/${(hostStorageAccount ?? "").toLowerCase()}`;
    const grants: string[] = [];
    for (const assignment of assignments) {
      const scope = assignment.properties?.scope?.toLowerCase() ?? "";
      if (scope.endsWith(host)) continue;
      const definition = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId: assignment.properties?.roleDefinitionId?.split("/").pop() ?? "",
      });
      const actions = (definition.properties?.permissions ?? [])
        .flatMap((p) => [...(p.actions ?? []), ...(p.dataActions ?? [])])
        .sort()
        .join("+");
      grants.push(`${actions} ${scope}`);
    }
    return grants.sort();
  }).pipe(Effect.provide(azure));

describe("Azure Batch ARM bindings on an Azure Function", { tags }, () => {
  test(
    "each binding grants exactly its action on its resource",
    Effect.gen(function* () {
      const { principalId, hostStorageAccount, accountId, autoStorageId } = yield* stack;
      const storage = "Microsoft.Storage/storageAccounts";
      const expected = [
        `Microsoft.Batch/batchAccounts/syncAutoStorageKeys/action ${accountId.toLowerCase()}`,
        `${storage}/listkeys/action+${storage}/read ${(autoStorageId ?? "").toLowerCase()}`,
      ].sort();
      // Role-assignment lists trail the deploy by a few seconds.
      const grants = yield* grantsOf(principalId ?? "", hostStorageAccount).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (grants) => grants.length >= expected.length,
          times: 24,
        }),
      );
      expect(grants).toEqual(expected);
    }),
    { timeout: 600_000 },
  );

  describe("Batch.SynchronizeAutoStorageKeys", () => {
    test(
      "re-syncs the bound account's auto-storage keys",
      Effect.gen(function* () {
        const before = yield* lastKeySync;
        const body = yield* call("/sync-keys");
        expectOk(body);
        const after = yield* lastKeySync.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (synced) => synced !== before,
            times: 12,
          }),
        );
        expect(Date.parse(after ?? "") > Date.parse(before ?? "")).toEqual(true);
      }),
      { timeout: 600_000 },
    );
  });

  describe("Batch.StopPoolResize", () => {
    // Skipped: the subscription's Batch pool quota is 0, so no pool can be
    // created to resize (`Conflict: Pool quota for the account has been
    // reached`).
    test.skip(
      "stops a pool resize",
      Effect.gen(function* () {
        expect(yield* call("/stop-resize")).toEqual({ ok: true, result: "stopped" });
      }),
      { timeout: 600_000 },
    );
  });
});
