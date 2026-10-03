import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { pollGone, sentinelWorkspace, tags } from "./sentinel.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getWatchlist = (
  resourceGroupName: string,
  workspaceName: string,
  watchlistAlias: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* securityinsights.GetWatchlist({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      watchlistAlias,
    });
  });

const countItems = (
  resourceGroupName: string,
  workspaceName: string,
  watchlistAlias: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const page = yield* securityinsights.ListWatchlistItems({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      watchlistAlias,
    });
    return page.value.length;
  });

const watchlistGone = (rg: string, ws: string, alias: string) =>
  pollGone(
    getWatchlist(rg, ws, alias).pipe(
      Effect.as("found" as const),
      Effect.catchTag(
        ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
        () => Effect.succeed("gone" as const),
      ),
    ),
  );

const program = (opts: { description: string; searchKey: string }) =>
  Effect.gen(function* () {
    const { group, logs, sentinel } = yield* sentinelWorkspace;
    const watchlist = yield* Azure.SecurityInsights.Watchlist("Servers", {
      resourceGroup: sentinel.resourceGroup,
      workspace: sentinel.workspace,
      displayName: "Approved servers",
      itemsSearchKey: opts.searchKey,
      source: "servers.csv",
      description: opts.description,
      labels: ["alchemy"],
      rawContent: "Hostname,Owner\nweb-01,platform\nweb-02,platform\n",
    });
    return { group, logs, watchlist };
  });

// Sentinel trial + empty workspace: ~$0 per run, ~3 minutes.
test.provider(
  "create, update, replace, and delete a Sentinel watchlist",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ description: "Servers v1", searchKey: "Hostname" }),
      );
      const rg = created.group.resourceGroupName;
      const ws = created.logs.workspaceName;
      const alias = created.watchlist.watchlistAlias;
      const observed = yield* getWatchlist(rg, ws, alias);
      expect(observed.properties?.displayName).toEqual("Approved servers");
      expect(observed.properties?.itemsSearchKey).toEqual("Hostname");
      expect(observed.properties?.description).toContain("Servers v1");

      // In-place update of the description.
      const updated = yield* stack.deploy(
        program({ description: "Servers v2", searchKey: "Hostname" }),
      );
      expect(updated.watchlist.watchlistAlias).toEqual(alias);
      const after = yield* getWatchlist(rg, ws, alias);
      expect(after.properties?.description).toContain("Servers v2");
      expect(after.properties?.watchlistId).toEqual(
        observed.properties?.watchlistId,
      );
      // A metadata update keeps the uploaded rows.
      expect(yield* countItems(rg, ws, alias)).toEqual(2);

      // Changing the search key replaces the watchlist.
      const replaced = yield* stack.deploy(
        program({ description: "Servers v2", searchKey: "Owner" }),
      );
      expect(replaced.watchlist.watchlistAlias).not.toEqual(alias);
      expect(yield* watchlistGone(rg, ws, alias)).toEqual("gone");
      const fresh = yield* getWatchlist(
        rg,
        ws,
        replaced.watchlist.watchlistAlias,
      );
      expect(fresh.properties?.itemsSearchKey).toEqual("Owner");

      yield* stack.destroy();
      expect(
        yield* watchlistGone(rg, ws, replaced.watchlist.watchlistAlias),
      ).toEqual("gone");
    }),
  { tags, timeout: 900_000 },
);
