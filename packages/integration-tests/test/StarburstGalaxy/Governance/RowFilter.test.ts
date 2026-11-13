import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import { expectGone, freshStack, pinnedName } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const filterExists = (rowFilterId: string) =>
  galaxy.rowFilter.getRowFilter({ rowFilterId }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

test.provider(
  "create, change, rename and delete a row filter",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);
      const renamed = yield* pinnedName("filter");

      const created = yield* stack.deploy(
        StarburstGalaxy.Governance.RowFilter("Filter", { expression: "region = 'EU'" }),
      );
      const rowFilterId = created.rowFilterId;
      const live = yield* galaxy.rowFilter.getRowFilter({ rowFilterId });
      expect(live.expression).toBe("region = 'EU'");
      expect(live.description).toBe("");

      // Every prop converges in place, the name included.
      const changed = yield* stack.deploy(
        StarburstGalaxy.Governance.RowFilter("Filter", {
          name: renamed,
          expression: "region IN ('EU', 'UK')",
          description: "europe",
        }),
      );
      expect(changed.rowFilterId).toBe(rowFilterId);
      const changedLive = yield* galaxy.rowFilter.getRowFilter({ rowFilterId });
      expect(changedLive.name).toBe(renamed);
      expect(changedLive.expression).toBe("region IN ('EU', 'UK')");
      expect(changedLive.description).toBe("europe");

      yield* stack.destroy();
      yield* expectGone(filterExists(rowFilterId));
    }).pipe(Effect.scoped),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:row-filter", "live"],
    timeout: 300_000,
  },
);
