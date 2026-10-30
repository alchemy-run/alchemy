import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { waitForOperation } from "./operations.ts";
import { normalizeLocation } from "./shared.ts";

/** Backend RAG Engine stores corpora in. */
export type RagEngineMode = "serverless" | "spanner";

/** Spanner-mode tier (`unprovisioned` deletes the managed database). */
export type RagEngineSpannerTier = "basic" | "scaled" | "unprovisioned";

export type RagEngineConfigProps = {
  /**
   * Region whose RAG Engine this configures.
   * @default "us-central1"
   */
  location?: string;
  /**
   * Backend RAG Engine stores corpora in. New projects can't create corpora
   * in Spanner mode in `us-central1`, `us-east1` or `us-east4` (it is
   * allowlisted there), so set `serverless` before creating a corpus.
   */
  mode: RagEngineMode;
  /**
   * Tier of the managed Spanner database, when `mode` is `spanner`.
   * @default "basic"
   */
  spannerTier?: RagEngineSpannerTier;
};

export type RagEngineConfig = Resource<
  "GCP.AIPlatform.RagEngineConfig",
  RagEngineConfigProps,
  {
    /** Full name, `projects/{project}/locations/{location}/ragEngineConfig`. */
    name: string;
    /** Project the setting belongs to. */
    project: string;
    /** Region the setting applies to. */
    location: string;
    /** Backend RAG Engine stores corpora in. */
    mode: RagEngineMode;
    /** Spanner-mode tier, when `mode` is `spanner`. */
    spannerTier: RagEngineSpannerTier | undefined;
  },
  never,
  Providers
>;

/**
 * The RAG Engine backend for one region of a project: serverless, or a
 * managed Spanner database at a chosen tier. Every RAG corpus in the region
 * uses it.
 *
 * The setting always exists, so Alchemy adopts it and sets the mode you
 * declare. Destroy releases Alchemy state and leaves the setting as it is:
 * switching back to Spanner mode is allowlisted in some regions, and the
 * setting is shared by every corpus in the region.
 *
 * ### Choosing a backend
 * **Example:** Serverless RAG Engine before creating a corpus
 * ```typescript
 * const rag = yield* GCP.AIPlatform.RagEngineConfig("Rag", {
 *   location: "us-central1",
 *   mode: "serverless",
 * });
 * const corpus = yield* GCP.AIPlatform.RagCorpora("Docs", {
 *   location: rag.location,
 *   displayName: "docs",
 * });
 * ```
 *
 * **Example:** Spanner at the scaled tier
 * ```typescript
 * yield* GCP.AIPlatform.RagEngineConfig("Rag", {
 *   location: "us-east1",
 *   mode: "spanner",
 *   spannerTier: "scaled",
 * });
 * ```
 *
 * @resource
 * @category Vertex AI
 */
export const RagEngineConfig = Resource<RagEngineConfig>("GCP.AIPlatform.RagEngineConfig");

const configName = (project: string, location: string) =>
  `projects/${project}/locations/${location}/ragEngineConfig`;

const observedMode = (
  config: aiplatform.GoogleCloudAiplatformV1RagManagedDbConfig | undefined,
): { mode: RagEngineMode; spannerTier: RagEngineSpannerTier | undefined } => {
  if (config?.serverless !== undefined) return { mode: "serverless", spannerTier: undefined };
  const spanner = config?.spanner ?? config;
  const spannerTier: RagEngineSpannerTier =
    spanner?.scaled !== undefined
      ? "scaled"
      : spanner?.unprovisioned !== undefined
        ? "unprovisioned"
        : "basic";
  return { mode: "spanner", spannerTier };
};

const desiredConfig = (
  mode: RagEngineMode,
  spannerTier: RagEngineSpannerTier,
): aiplatform.GoogleCloudAiplatformV1RagManagedDbConfig =>
  mode === "serverless" ? { serverless: {} } : { spanner: { [spannerTier]: {} } };

export const RagEngineConfigProvider = () =>
  Provider.succeed(RagEngineConfig, {
    stables: ["name", "project", "location"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (
        output !== undefined &&
        normalizeLocation(news.location, "us-central1") !== output.location
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const project = output?.project ?? env.project;
      const location = output?.location ?? normalizeLocation(olds?.location, "us-central1");
      const name = configName(project, location);
      const config = yield* aiplatform.getRagEngineConfigProjectsLocations({ name });
      return { name, project, location, ...observedMode(config.ragManagedDbConfig) };
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const project = output?.project ?? env.project;
      const location = normalizeLocation(news.location, "us-central1");
      const name = configName(project, location);
      const spannerTier = news.spannerTier ?? "basic";

      // Observe
      const current = yield* aiplatform.getRagEngineConfigProjectsLocations({ name });
      const observed = observedMode(current.ragManagedDbConfig);

      // Sync: the setting always exists; update it only when it differs.
      if (
        observed.mode !== news.mode ||
        (news.mode === "spanner" && observed.spannerTier !== spannerTier)
      ) {
        const operation = yield* aiplatform.updateRagEngineConfigProjectsLocations({
          name,
          body: { name, ragManagedDbConfig: desiredConfig(news.mode, spannerTier) },
        });
        yield* waitForOperation(operation);
      }

      return {
        name,
        project,
        location,
        mode: news.mode,
        spannerTier: news.mode === "spanner" ? spannerTier : undefined,
      };
    }),

    // The setting can't be removed, and reverting it would affect every
    // corpus in the region: destroy only releases Alchemy state.
    delete: Effect.fn(function* () {}),
  });
