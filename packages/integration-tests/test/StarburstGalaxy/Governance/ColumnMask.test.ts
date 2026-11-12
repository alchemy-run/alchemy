import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import { expectGone, pinnedName } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const maskExists = (columnMaskId: string) =>
  galaxy.columnMask.getColumnMask({ columnMaskId }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

test.provider(
  "create, change, rename and delete a column mask",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const renamed = yield* pinnedName("mask");

      const created = yield* stack.deploy(
        StarburstGalaxy.ColumnMask("Mask", {
          type: "Varchar",
          expression: "'XXX-XX-' || substr(ssn, -4)",
        }),
      );
      const columnMaskId = created.columnMaskId;
      const live = yield* galaxy.columnMask.getColumnMask({ columnMaskId });
      expect(live.columnMaskType).toBe("Varchar");
      expect(live.expression).toBe("'XXX-XX-' || substr(ssn, -4)");
      expect(live.description).toBe("");

      // Every prop converges in place, the name included.
      const changed = yield* stack.deploy(
        StarburstGalaxy.ColumnMask("Mask", {
          name: renamed,
          type: "Integer",
          expression: "CAST(NULL AS integer)",
          description: "salary",
        }),
      );
      expect(changed.columnMaskId).toBe(columnMaskId);
      const changedLive = yield* galaxy.columnMask.getColumnMask({ columnMaskId });
      expect(changedLive.name).toBe(renamed);
      expect(changedLive.columnMaskType).toBe("Integer");
      expect(changedLive.expression).toBe("CAST(NULL AS integer)");
      expect(changedLive.description).toBe("salary");

      yield* stack.destroy();
      yield* expectGone(maskExists(columnMaskId));
    }),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:column-mask", "live"],
    timeout: 90_000,
  },
);
