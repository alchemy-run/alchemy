import { misuseGroups } from "./conformance/misuse.ts";
import { check } from "./conformance/run.ts";

// Each function of the library the prover models, called in ways a handler should not call it.
check(misuseGroups(process.env.MISUSE_MODULES?.split(",")));
