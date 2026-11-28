import { it } from "@effect/vitest";
import { libraryRunGroups, misuseGroups } from "./conformance/misuse.ts";
import { check } from "./conformance/run.ts";

// Each function of the library the prover models, called in ways a handler
// should not call it. It is long: `pnpm test:coverage` runs it, with MISUSE set.
if (process.env.MISUSE)
  check([
    ...misuseGroups(process.env.MISUSE_MODULES?.split(",")),
    ...(process.env.MISUSE_MODULES ? [] : libraryRunGroups()),
  ]);
else it.skip("the misuse tables run with MISUSE set", () => {});
