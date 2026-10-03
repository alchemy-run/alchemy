import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { pollGone, sentinelWorkspace, tags } from "./sentinel.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getItem = (
  resourceGroupName: string,
  workspaceName: string,
  watchlistAlias: string,
  watchlistItemId: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* securityinsights.GetWatchlistItem({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      watchlistAlias,
      watchlistItemId,
    });
  });

const itemGone = (rg: string, ws: string, alias: string, itemId: string) =>
  pollGone(
    getItem(rg, ws, alias, itemId).pipe(
      Effect.as("found" as const),
      Effect.catchTag(
        ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
        () => Effect.succeed("gone" as const),
      ),
    ),
  );

const REPLACEMENT_ID = "3f0e7c2a-9b1d-4e5f-8a6b-1c2d3e4f5a6b";

const program = (opts: { tier?: string; itemId?: string; withItem?: boolean }) =>
  Effect.gen(function* () {
    const { group, logs, sentinel } = yield* sentinelWorkspace;
    const watchlist = yield* Azure.SecurityInsights.Watchlist("Vips", {
      resourceGroup: sentinel.resourceGroup,
      workspace: sentinel.workspace,
      displayName: "VIP users",
      itemsSearchKey: "UserPrincipalName",
      source: "vips.csv",
      rawContent: "UserPrincipalName,Tier\nseed@contoso.com,3\n",
    });
    const item =
      opts.withItem === false
        ? undefined
        : yield* Azure.SecurityInsights.WatchlistItem("Ceo", {
            resourceGroup: watchlist.resourceGroup,
            workspace: watchlist.workspace,
            watchlistAlias: watchlist.watchlistAlias,
            watchlistItemId: opts.itemId,
            itemsKeyValue: {
              UserPrincipalName: "ceo@contoso.com",
              Tier: opts.tier ?? "1",
            },
          });
    return { group, logs, watchlist, item };
  });

// Sentinel trial + empty workspace: ~$0 per run, ~3 minutes.
test.provider(
  "create, update, replace, and delete a Sentinel watchlist item",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ tier: "1" }));
      const rg = created.group.resourceGroupName;
      const ws = created.logs.workspaceName;
      const alias = created.watchlist.watchlistAlias;
      const itemId = created.item!.watchlistItemId;
      const observed = yield* getItem(rg, ws, alias, itemId);
      expect(observed.properties?.itemsKeyValue).toMatchObject({
        UserPrincipalName: "ceo@contoso.com",
        Tier: "1",
      });

      const updated = yield* stack.deploy(program({ tier: "2" }));
      expect(updated.item!.watchlistItemId).toEqual(itemId);
      const after = yield* getItem(rg, ws, alias, itemId);
      expect(after.properties?.itemsKeyValue).toMatchObject({ Tier: "2" });

      const replaced = yield* stack.deploy(
        program({ tier: "2", itemId: REPLACEMENT_ID }),
      );
      expect(replaced.item!.watchlistItemId).toEqual(REPLACEMENT_ID);
      expect(yield* itemGone(rg, ws, alias, itemId)).toEqual("gone");

      // Removing the item deletes only the row.
      yield* stack.deploy(program({ withItem: false }));
      expect(yield* itemGone(rg, ws, alias, REPLACEMENT_ID)).toEqual("gone");

      yield* stack.destroy();
    }),
  { tags, timeout: 900_000 },
);
