/**
 * Process entry for an async (non-Effect) `Azure.ContainerApps.Job`. The
 * generated entry imports this module and the user's handler file, nothing
 * else, so the image carries no Effect runtime.
 *
 * The handler file default-exports `{ run(env) }`. `env` holds the values
 * of the job's `env` prop, decoded from the container's environment:
 * strings stay strings, resources arrive as their attributes, and secrets
 * arrive as plain strings. The process exits 0 when `run` resolves and 1
 * when it throws, which marks the execution succeeded or failed.
 */

/** The shape an async job handler file default-exports. */
export interface AsyncJobHandler {
  run?: (env: any) => unknown;
}

// Must stay in step with `packEnvValue` in `alchemy/RuntimeContext`.
const decode = (raw: string | undefined): unknown => {
  if (raw === undefined || !/^[\x20\t\r\n]*["{[0-9tfn-]/.test(raw)) return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { _tag?: unknown })._tag === "Redacted" &&
      typeof (parsed as { value?: unknown }).value === "string"
    ) {
      return (parsed as { value: string }).value;
    }
    return parsed;
  } catch {
    return raw;
  }
};

/** Run `handler.run(env)` once, then exit with its outcome. */
export const run = async (handler: AsyncJobHandler, envKeys: readonly string[]): Promise<void> => {
  const env: Record<string, unknown> = {};
  for (const key of envKeys) env[key] = decode(process.env[key]);
  console.log("Container Apps job starting...");
  try {
    await handler.run?.call(handler, env);
    console.log("Container Apps job completed.");
    process.exit(0);
  } catch (error) {
    console.error("Container Apps job failed:", error);
    process.exit(1);
  }
};
