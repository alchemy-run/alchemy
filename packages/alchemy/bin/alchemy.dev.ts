// Source-mode CLI entry for running a checkout under node without a build.
//
// `bin/alchemy.ts` imports through the `alchemy` package specifier, whose
// node `import` condition resolves to the built `lib/` — so it needs a
// `tsc -b` first. This twin imports the source tree relatively; the launcher
// (`bin/cli.js`) points node here with type stripping plus the
// `register-tsx.js` hook so `.ts` and `.tsx` both load with zero build.
import { main } from "../src/Cli/index.ts";
import { runMain } from "../src/Util/PlatformServices.ts";

main.pipe(runMain);
