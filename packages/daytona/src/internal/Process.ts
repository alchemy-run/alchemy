import * as process from "@distilled.cloud/daytona/process";
import * as Effect from "effect/Effect";
import { inSandbox } from "./Toolbox.ts";

/**
 * Run a shell command in a sandbox through the toolbox. The command is
 * passed base64-encoded to `sh`, as Daytona's own SDKs do, so pipes,
 * quotes and `&&` behave as in a shell.
 */
export const runCommand = (
  sandboxId: string,
  toolboxProxyUrl: string | undefined,
  request: { command: string; cwd?: string; env?: Record<string, string>; timeout?: number },
) =>
  Effect.sync(() => Buffer.from(request.command).toString("base64")).pipe(
    Effect.flatMap((encoded) =>
      process.executeCommand({
        command: `sh -c "echo '${encoded}' | base64 -d | sh"`,
        cwd: request.cwd,
        envs: request.env,
        timeout: request.timeout,
      }),
    ),
    inSandbox(sandboxId, toolboxProxyUrl),
  );
