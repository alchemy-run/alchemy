import { groups } from "./conformance/cases.ts";
import { check } from "./conformance/run.ts";

// One part in four of the library table: the parts run side by side.
check(groups.filter((_, index) => index % 4 === 1));
