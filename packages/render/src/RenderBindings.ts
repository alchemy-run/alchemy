import type { Resource } from "alchemy/Resource";
import type { SecretString } from "./Types.ts";

/**
 * Binding contract accepted by Render compute services (`WebService`,
 * `PrivateService`, `BackgroundWorker`, `CronJob`, `StaticSite`).
 */
export interface RenderServiceBinding {
  /** Environment variables injected onto the Render service during reconcile. */
  env?: Record<string, SecretString>;
}

const RENDER_HOST_TYPES = new Set<string>([
  "Render.WebService",
  "Render.PrivateService",
  "Render.BackgroundWorker",
  "Render.CronJob",
  "Render.StaticSite",
  "Render.ServicePreview",
]);

/** Returns true when a `Binding.Host` is one of Render's compute services. */
export const isRenderHost = (
  host: unknown,
): host is Resource<string, any, any, RenderServiceBinding> =>
  typeof host === "object" &&
  host !== null &&
  typeof (host as { Type?: unknown }).Type === "string" &&
  RENDER_HOST_TYPES.has((host as { Type: string }).Type);
