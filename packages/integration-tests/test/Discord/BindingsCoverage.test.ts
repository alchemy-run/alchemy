import { expect, test } from "@alchemy.run/test";
import bindings from "../../../discord/scripts/bindings.json" with { type: "json" };
import { cases } from "./bindings-cases.ts";

test(
  "every Discord binding has a case in Bindings.test.ts",
  () => {
    const names = (bindings as Array<{ name: string }>).map((b) => b.name).sort();
    expect(Object.keys(cases).sort()).toEqual(names);
  },
  { tags: ["provider:discord", "provider:discord:bindings", "unit"] },
);
