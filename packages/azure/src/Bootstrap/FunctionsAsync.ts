/**
 * Process entry for an async (non-Effect) `Azure.Functions.Function` or
 * `Azure.Web.FunctionApp`. The generated entry imports this module and the
 * user's handler file, nothing else, so the deployed package carries no
 * Effect runtime.
 *
 * The handler file default-exports `{ fetch(request, env) }`. `env` holds the
 * values of the Function's `env` prop, decoded from app settings: strings
 * stay strings, resources arrive as their attributes, and secrets arrive as
 * plain strings.
 */
import { registerHttpFunction } from "./FunctionsCore.ts";

/** The shape an async handler file default-exports. */
export interface AsyncHandler {
  fetch?: (request: Request, env: any) => Response | Promise<Response>;
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

/** Register `handler.fetch` as the app's catch-all HTTP function. */
export const serve = (handler: AsyncHandler, envKeys: readonly string[]) => {
  const env: Record<string, unknown> = {};
  for (const key of envKeys) env[key] = decode(process.env[key]);
  const fetch = handler.fetch;
  if (fetch === undefined) return;
  registerHttpFunction("http", async (request) => fetch.call(handler, request, env));
};
