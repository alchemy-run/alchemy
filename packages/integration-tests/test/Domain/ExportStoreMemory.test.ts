import * as ExportStore from "@alchemy.run/domain/Export/Store";
import { describe, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import { storeConformance } from "./export-conformance/conformance.ts";

describe("Domain Export memory store", { tags: ["unit", "local"] }, () => {
  storeConformance({
    test: (name, effect, options) => it.effect(name, () => effect, options),
    make: Effect.sync(ExportStore.memory),
    kind: "local",
    runs: 200,
  });
});
