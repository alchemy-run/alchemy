import { exec } from "alchemy/Cli/Commands";
import { runMain } from "alchemy/Util";

exec.pipe(runMain);
