// Source-mode dev-supervisor exec entry — see `bin/alchemy.dev.ts` for why
// this twin of `bin/exec.ts` imports the source tree relatively.
import { exec } from "../src/Cli/index.ts";
import { runMain } from "../src/Util/PlatformServices.ts";

exec().pipe(runMain);
