import * as Region from "@distilled.cloud/gcp/Region";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GcpEnvironment } from "./Environment.ts";

export {
  Region,
  RegionalEndpoints,
  type RegionName,
  type RegionalEndpointMode,
} from "@distilled.cloud/gcp/Region";

/**
 * Default region for every GCP resource in scope that is created without
 * an explicit `location` / `region` — the GCP counterpart of
 * `AWS.Region.of`. Without it, the region comes from the profile, then
 * `GOOGLE_CLOUD_REGION` / `CLOUDSDK_COMPUTE_REGION`, then `us-central1`.
 *
 * ### Choosing a region
 * **Example:** Deploy a stack to europe-west1
 * ```typescript
 * export default Alchemy.Stack(
 *   "App",
 *   {
 *     providers: GCP.providers().pipe(
 *       Layer.provideMerge(GCP.Region.of("europe-west1")),
 *     ),
 *     state: Alchemy.localState(),
 *   },
 *   program,
 * );
 * ```
 *
 * A single resource in another region takes an explicit `location` /
 * `region` prop instead.
 */
export const of = (region: Region.RegionName) => Region.of(region);

/** Default region from `GOOGLE_CLOUD_REGION` / `CLOUDSDK_COMPUTE_REGION`. */
export const fromEnv = () => Region.fromEnv();

/**
 * Route requests to Google's regional endpoints
 * (`{service}.{region}.rep.googleapis.com`):
 *
 * - `"required"` (default): only where the global endpoint rejects
 *   regional resources (Secret Manager, Parameter Manager).
 * - `"prefer"`: every request for a regional resource whose service
 *   publishes a regional endpoint, so traffic terminates in-region.
 * - `"never"`: always the global endpoint.
 */
export const regionalEndpoints = (mode: Region.RegionalEndpointMode) =>
  Region.regionalEndpoints(mode);

/** The effective default region in the current scope. */
export const current = Effect.suspend(() =>
  GcpEnvironment.use((env) => Effect.map(env, ({ region }) => region)),
);

export type RegionLayer = Layer.Layer<Region.Region>;
