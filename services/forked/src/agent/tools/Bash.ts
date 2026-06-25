import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { Sandbox } from "../Sandbox.ts";

export const command = AI.Parameter(
  "command",
  S.String,
)`The command to execute`;

export const timeout = AI.Parameter("timeout")(S.Number.pipe(S.optional))`
Optional timeout in milliseconds`;

export const workdir = AI.Parameter("workdir")(S.String.pipe(S.optional))`
The working directory to run the command in, relative to the workspace root.
Defaults to the workspace root. Use this instead of \`cd\` commands.`;

export class Bash extends AI.Tool<Bash>()("bash")`
Executes a given bash command in the sandbox (a Linux container) with optional
timeout, ensuring proper handling and security measures.

All commands run in the workspace root by default. Use the ${workdir} parameter
if you need to run a command in a different directory. AVOID using
\`cd <directory> && <command>\` patterns — use ${workdir} instead.

Before executing the ${command}, please follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use \`ls\` to
     verify the parent directory exists and is the correct location.
   - For example, before running "mkdir foo/bar", first use \`ls foo\` to check
     that "foo" exists and is the intended parent directory.

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes (e.g.,
     rm "path with spaces/file.txt").
   - After ensuring proper quoting, execute the command.
   - Capture the output of the command.

Usage notes:
  - The command argument is required.
  - You can specify an optional ${timeout} in milliseconds. If not specified,
    commands time out after 120000ms.
  - If the output is very large it will be truncated.
  - Avoid using bash with the \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`,
    \`sed\`, \`awk\`, or \`echo\` commands unless explicitly instructed or truly
    necessary. Instead, always prefer the dedicated tools:
    - File search: use the glob tool (NOT find or ls)
    - Content search: use the grep tool (NOT grep or rg)
    - Read files: use the read tool (NOT cat/head/tail)
    - Edit files: use the edit tool (NOT sed/awk)
    - Write files: use the write tool (NOT echo >/cat <<EOF)
    - Communication: output text directly (NOT echo/printf)
  - When issuing multiple commands:
    - If the commands are independent and can run in parallel, make multiple
      bash tool calls in a single message.
    - If the commands depend on each other and must run sequentially, use a
      single bash call with \`&&\` to chain them together (e.g.,
      \`git add . && git commit -m "message"\`).
    - Use \`;\` only when you need to run commands sequentially but don't care
      if earlier commands fail.
    - DO NOT use newlines to separate commands (newlines are ok in quoted
      strings).` {}

export const BashLive = Layer.effect(
  Bash,
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    return Effect.fn("bash")(function* (params) {
      const { command, timeout, workdir } = params as {
        command: string;
        timeout?: number;
        workdir?: string;
      };
      return yield* sandbox.exec(command, { cwd: workdir, timeoutMs: timeout });
    });
  }),
);
