import * as projects from "@distilled.cloud/vercel/projects";
import * as webAnalytics from "@distilled.cloud/vercel/web_analytics";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";
import type { Providers } from "../Providers.ts";

export interface WebAnalyticsProps {
  /**
   * The project (ID or name) to enable Web Analytics on. Changing the
   * project replaces the resource (analytics is toggled off on the old
   * project and on for the new one).
   */
  project: string;
}

export type WebAnalytics = Resource<
  "Vercel.WebAnalytics",
  WebAnalyticsProps,
  {
    /** Resolved ID of the project analytics is enabled on. */
    projectId: string;
    /** ID of the project's Web Analytics instance. */
    analyticsId: string;
    /** Timestamp (ms) when analytics was (last) enabled. */
    enabledAt: number | undefined;
    /** Timestamp (ms) when analytics was last disabled, if ever. */
    disabledAt: number | undefined;
  },
  never,
  Providers
>;

type WebAnalyticsAttributes = WebAnalytics["Attributes"];

/**
 * Vercel Web Analytics enablement for a project.
 *
 * The platform models analytics as a per-project toggle (`POST
 * /web/insights/toggle`); this resource declares the toggle **on** while it
 * exists and toggles it back **off** on destroy. The observed state lives on
 * the project itself (`project.webAnalytics`).
 *
 * Note that collecting page views additionally requires the
 * `@vercel/analytics` script in the deployed app — this resource manages
 * only the platform-side enablement.
 *
 * @resource
 * @section Enabling Web Analytics
 * @example Enable analytics on a project
 * ```typescript
 * const project = yield* Vercel.Project("Site", {});
 * yield* Vercel.WebAnalytics("Analytics", {
 *   project: project.projectId,
 * });
 * ```
 *
 * @see https://vercel.com/docs/analytics
 */
export const WebAnalytics = Resource<WebAnalytics>("Vercel.WebAnalytics");

/**
 * Observe the project's analytics state. Returns `undefined` when the
 * project doesn't exist; `{ projectId, analytics }` otherwise (with
 * `analytics` undefined when never enabled).
 */
const observeProjectAnalytics = (idOrName: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    return yield* projects.getProject({ idOrName, teamId }).pipe(
      Effect.map((project) => ({
        projectId: project.id,
        analytics: project.webAnalytics,
      })),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );
  });

const isEnabled = (
  analytics: projects.CreateProjectResponseWebAnalytics | undefined,
): analytics is projects.CreateProjectResponseWebAnalytics =>
  analytics !== undefined &&
  (analytics.disabledAt === undefined ||
    (analytics.enabledAt ?? 0) > analytics.disabledAt);

const toAttributes = (
  projectId: string,
  analytics: projects.CreateProjectResponseWebAnalytics,
): WebAnalyticsAttributes => ({
  projectId,
  analyticsId: analytics.id,
  enabledAt: analytics.enabledAt,
  disabledAt: analytics.disabledAt,
});

export const WebAnalyticsProvider = () =>
  Provider.succeed(WebAnalytics, {
    stables: ["projectId", "analyticsId"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      // The toggle is bound to its project — a different project is a
      // different resource.
      if (news.project !== olds.project) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const idOrName = output?.projectId ?? olds?.project;
      if (idOrName === undefined) return undefined;
      const observed = yield* observeProjectAnalytics(idOrName);
      if (observed === undefined || !isEnabled(observed.analytics)) {
        return undefined;
      }
      const attrs = toAttributes(observed.projectId, observed.analytics);
      // Analytics already enabled without prior state may have been enabled
      // out-of-band — gate takeover behind `--adopt`.
      return output !== undefined ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const { teamId } = yield* VercelEnvironment.current;

      // Observe — the project's own `webAnalytics` field is the truth.
      const observed = yield* observeProjectAnalytics(news.project);
      if (observed === undefined) {
        return yield* Effect.die(
          `Vercel.WebAnalytics: project ${news.project} not found`,
        );
      }

      // Ensure — toggle on only when not already enabled.
      if (!isEnabled(observed.analytics)) {
        yield* webAnalytics.createWebInsightsToggle({
          projectId: observed.projectId,
          value: true,
          teamId,
        });
      }

      // Return — re-read the final state.
      const fresh = yield* observeProjectAnalytics(observed.projectId);
      if (fresh === undefined || !isEnabled(fresh.analytics)) {
        return yield* Effect.die(
          `Vercel.WebAnalytics: analytics not observable on project ${observed.projectId} after enabling`,
        );
      }
      return toAttributes(fresh.projectId, fresh.analytics);
    }),
    delete: Effect.fn(function* ({ output }) {
      const { teamId } = yield* VercelEnvironment.current;
      // Toggling off a project that's already gone is not an error.
      yield* webAnalytics
        .createWebInsightsToggle({
          projectId: output.projectId,
          value: false,
          teamId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
