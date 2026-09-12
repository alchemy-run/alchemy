import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  encodeOwnershipLine,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  locationOf,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  sameText,
  toResourceId,
  updateMaskOf,
} from "./ownership.ts";

export type AnnotatorSelector = {
  /** Run the sentiment annotator. */
  runSentimentAnnotator?: boolean;
  /** Run the summarization annotator. */
  runSummarizationAnnotator?: boolean;
  /** Run the QA annotator. */
  runQaAnnotator?: boolean;
  /** Run the silence annotator. */
  runSilenceAnnotator?: boolean;
  /** Run active phrase matcher annotators. */
  runPhraseMatcherAnnotator?: boolean;
  /** Run the entity annotator. */
  runEntityAnnotator?: boolean;
  /** Run the intent annotator. */
  runIntentAnnotator?: boolean;
  /** Run the interruption annotator. */
  runInterruptionAnnotator?: boolean;
  /** Run the issue-model annotator. */
  runIssueModelAnnotator?: boolean;
  /** Run the auto-labeling annotator. */
  runAutoLabelingAnnotator?: boolean;
  /** Issue model resource names. Used when `runIssueModelAnnotator` is true. */
  issueModels?: string[];
  /** Phrase matcher resource names. Used when `runPhraseMatcherAnnotator` is true. */
  phraseMatchers?: string[];
};

export type AnalysisRuleProps = {
  /**
   * Analysis rule id (the `{analysis_rule}` segment of
   * `projects/{project}/locations/{location}/analysisRules/{analysis_rule}`).
   * If omitted, a unique id is generated. Immutable — changing it replaces
   * the rule.
   */
  analysisRuleId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the rule.
   * `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default "us-central1"
   */
  location?: string;
  /**
   * Display name. Analysis rules have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  displayName?: string;
  /**
   * Filter selecting conversations this rule applies to. Empty applies to
   * all conversations.
   */
  conversationFilter?: string;
  /**
   * When true, the rule is applied to matching conversations. When false,
   * it is stored as a draft.
   * @default false
   */
  active?: boolean;
  /**
   * Fraction of matching conversations to analyze automatically, in `[0, 1]`.
   * @default 0
   */
  analysisPercentage?: number;
  /**
   * Annotators to run on matching conversations. Omitted means no
   * annotators run.
   */
  annotatorSelector?: AnnotatorSelector;
};

export type AnalysisRule = Resource<
  "GCP.Contactcenterinsights.AnalysisRule",
  AnalysisRuleProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/analysisRules/{analysis_rule}`. */
    name: string;
    /** Analysis rule id (last path segment). */
    analysisRuleId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Conversation filter. */
    conversationFilter: string | undefined;
    /** Whether the rule is active. */
    active: boolean;
    /** Automatic analysis percentage. */
    analysisPercentage: number | undefined;
    /** Annotator selector. */
    annotatorSelector: AnnotatorSelector | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Contact Center AI Insights analysis rule that selects conversations
 * and the annotators to run on them.
 *
 * Analysis rules have no labels field — Alchemy stamps ownership into the
 * display name so `list` / nuke can find them. Location and id are
 * immutable. Filter, active flag, analysis percentage, and annotators
 * update in place.
 *
 * ### Creating an Analysis Rule
 * **Example:** Inactive draft rule
 * ```typescript
 * const rule = yield* GCP.Contactcenterinsights.AnalysisRule("Draft", {
 *   displayName: "draft-sentiment",
 *   active: false,
 *   analysisPercentage: 0,
 *   annotatorSelector: { runSentimentAnnotator: true },
 * });
 * ```
 *
 * **Example:** Named rule with a conversation filter
 * ```typescript
 * const rule = yield* GCP.Contactcenterinsights.AnalysisRule("Draft", {
 *   analysisRuleId: "sentiment-en",
 *   conversationFilter: 'language_code="en-US"',
 *   active: false,
 *   annotatorSelector: { runSentimentAnnotator: true },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Contactcenterinsights
 */
export const AnalysisRule = Resource<AnalysisRule>(
  "GCP.Contactcenterinsights.AnalysisRule",
);

export class AnalysisRuleNotResolved extends Data.TaggedError(
  "GCP.Contactcenterinsights.AnalysisRuleNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  project: string,
  location: string,
  analysisRuleId: string,
) => `${locationParent(project, location)}/analysisRules/${analysisRuleId}`;

const selectorOf = (
  selector: cci.GoogleCloudContactcenterinsightsV1AnnotatorSelector | undefined,
): AnnotatorSelector | undefined => {
  if (selector === undefined) return undefined;
  return {
    runSentimentAnnotator: selector.runSentimentAnnotator,
    runSummarizationAnnotator: selector.runSummarizationAnnotator,
    runQaAnnotator: selector.runQaAnnotator,
    runSilenceAnnotator: selector.runSilenceAnnotator,
    runPhraseMatcherAnnotator: selector.runPhraseMatcherAnnotator,
    runEntityAnnotator: selector.runEntityAnnotator,
    runIntentAnnotator: selector.runIntentAnnotator,
    runInterruptionAnnotator: selector.runInterruptionAnnotator,
    runIssueModelAnnotator: selector.runIssueModelAnnotator,
    runAutoLabelingAnnotator: selector.runAutoLabelingAnnotator,
    issueModels: selector.issueModels,
    phraseMatchers: selector.phraseMatchers,
  };
};

const toAttrs = (
  rule: cci.GoogleCloudContactcenterinsightsV1AnalysisRule,
  project: string,
) => {
  const name = rule.name ?? "";
  const parsed = parseOwnership(rule.displayName);
  return {
    name,
    analysisRuleId: lastSegment(name),
    location: locationOf(name),
    project,
    displayName: parsed.text,
    conversationFilter: rule.conversationFilter,
    active: rule.active === true,
    analysisPercentage: rule.analysisPercentage,
    annotatorSelector: selectorOf(rule.annotatorSelector),
    createTime: rule.createTime,
    updateTime: rule.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cci
        .getProjectsLocationsAnalysisRules({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string) =>
  cci.listProjectsLocationsAnalysisRules.pages({ parent, pageSize: 1000 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.analysisRules ?? [])),
    Stream.filter((rule) => hasOwnershipMarker(rule.displayName)),
    Stream.map((rule) => toAttrs(rule, project)),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
    Effect.catchTag("Forbidden", () => Effect.succeed([])),
  );

const findByDisplayName = (parent: string, displayName: string) =>
  cci.listProjectsLocationsAnalysisRules.pages({ parent, pageSize: 1000 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.analysisRules ?? [])),
    Stream.filter((rule) => rule.displayName === displayName),
    Stream.runHead,
    Effect.map((option) => (option._tag === "Some" ? option.value : undefined)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
  );

export const AnalysisRuleProvider = () =>
  Provider.succeed(AnalysisRule, {
    stables: ["name", "analysisRuleId", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousLocation = olds?.location ?? output?.location;
      const nextLocation = normalizeLocation(news.location);
      if (
        previousLocation !== undefined &&
        normalizeLocation(previousLocation) !== nextLocation
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.analysisRuleId ?? output?.analysisRuleId;
      if (
        previousId !== undefined &&
        news.analysisRuleId !== undefined &&
        news.analysisRuleId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const analysisRuleId = yield* toResourceId(
        id,
        olds?.analysisRuleId,
        output?.analysisRuleId,
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ?? resourceName(env.project, location, analysisRuleId);
      let existing = yield* getByName(name);
      if (existing === undefined && output?.name === undefined) {
        const ownership = yield* createInternalLabels(id);
        existing = yield* findByDisplayName(
          locationParent(env.project, location),
          encodeOwnershipLine(ownership, olds?.displayName),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listAt(
          locationParent(env.project, DEFAULT_LOCATION),
          env.project,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? DEFAULT_LOCATION,
      );
      const parent = locationParent(env.project, location);
      const analysisRuleId = yield* toResourceId(
        id,
        news.analysisRuleId,
        output?.analysisRuleId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, analysisRuleId);
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(ownership, news.displayName);
      const active = news.active === true;
      const analysisPercentage = news.analysisPercentage ?? 0;
      const annotatorSelector = news.annotatorSelector;

      let current = yield* getByName(name);
      if (current === undefined) {
        current = yield* findByDisplayName(parent, displayName);
      }

      if (current === undefined) {
        const created = yield* cci
          .createProjectsLocationsAnalysisRules({
            parent,
            body: {
              name,
              displayName,
              conversationFilter: news.conversationFilter,
              active,
              analysisPercentage,
              annotatorSelector,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? (yield* findByDisplayName(parent, displayName));
      }

      if (current === undefined) {
        return yield* new AnalysisRuleNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = (current.displayName ?? "") !== displayName;
      const filterChanged = !sameText(
        current.conversationFilter,
        news.conversationFilter,
      );
      const activeChanged = (current.active === true) !== active;
      const percentageChanged =
        (current.analysisPercentage ?? 0) !== analysisPercentage;
      const selectorChanged = !jsonEqual(
        selectorOf(current.annotatorSelector),
        annotatorSelector,
      );

      if (
        displayChanged ||
        filterChanged ||
        activeChanged ||
        percentageChanged ||
        selectorChanged
      ) {
        current = yield* cci.patchProjectsLocationsAnalysisRules({
          name: currentName,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            filterChanged ? "conversation_filter" : undefined,
            activeChanged ? "active" : undefined,
            percentageChanged ? "analysis_percentage" : undefined,
            selectorChanged ? "annotator_selector" : undefined,
          ),
          body: {
            name: currentName,
            displayName,
            conversationFilter: news.conversationFilter,
            active,
            analysisPercentage,
            annotatorSelector,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* cci
        .deleteProjectsLocationsAnalysisRules({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
