import * as OpenRouter from "@distilled.cloud/openrouter";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { deepEqual, isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

/** How often a {@link Guardrail}'s `limitUsd` budget resets. */
export type GuardrailResetInterval = "daily" | "weekly" | "monthly";

/** Ingress regions a {@link Guardrail} can restrict requests to. */
export type GuardrailDataRegion = "global" | "europe" | "us";

/** Action a content filter takes when it matches. `flag` only records the match. */
export type GuardrailContentFilterAction = "redact" | "block" | "flag";

/** A custom regex content filter applied to request messages. */
export interface GuardrailContentFilter {
  /** Regex pattern matched against request content. */
  pattern: string;
  /** What to do on a match. */
  action: GuardrailContentFilterAction;
  /** Label used in redaction placeholders and error messages. */
  label?: string;
}

/** A builtin content filter (PII, secrets, prompt-injection detectors). */
export interface GuardrailContentFilterBuiltin {
  /**
   * Builtin detector, e.g. `email`, `phone`, `ssn`, `credit-card`,
   * `ip-address`, `secrets`, `person-name`, `address`,
   * `regex-prompt-injection`.
   */
  slug: string;
  /** What to do on a match. */
  action: GuardrailContentFilterAction;
  /**
   * Message roles scanned by `regex-prompt-injection`.
   * @default "all_messages"
   */
  scanScope?: "user_only" | "all_messages";
}

export interface GuardrailProps {
  /**
   * Name of the guardrail. Changing it renames the guardrail in place.
   * @default an instance-qualified physical name derived from the app, stage and logical ID
   */
  name?: string;
  /** Free-form description. */
  description?: string;
  /**
   * Spending limit in USD across every key assigned to the guardrail. Must
   * be set together with `resetInterval`.
   */
  limitUsd?: number;
  /** How often `limitUsd` resets. Required when `limitUsd` is set. */
  resetInterval?: GuardrailResetInterval;
  /**
   * Whether BYOK inference spend counts toward `limitUsd`.
   * @default false
   */
  includeByokInBudgets?: boolean;
  /** Only route to these provider IDs (e.g. `["anthropic", "openai"]`). */
  allowedProviders?: string[];
  /** Never route to these provider IDs. */
  ignoredProviders?: string[];
  /**
   * Only allow these models (slug or canonical slug, e.g.
   * `"anthropic/claude-sonnet-4.5"`). OpenRouter stores canonical slugs.
   */
  allowedModels?: string[];
  /** Exclude these models from routing. */
  ignoredModels?: string[];
  /** Only accept requests arriving through these regional endpoints. */
  allowedDataRegions?: GuardrailDataRegion[];
  /**
   * Enforce zero data retention for every provider family (Anthropic,
   * OpenAI, Google, xAI and others).
   */
  enforceZdr?: boolean;
  /** Allow paid endpoints that train on request data. */
  enablePaidModelTraining?: boolean;
  /** Allow free endpoints that train on request data. */
  enableFreeModelTraining?: boolean;
  /** Allow free endpoints that publish prompts. */
  enableFreeModelPublication?: boolean;
  /** Custom regex content filters. */
  contentFilters?: GuardrailContentFilter[];
  /** Builtin PII / secret / prompt-injection filters. */
  contentFilterBuiltins?: GuardrailContentFilterBuiltin[];
  /**
   * Hashes of the API keys the guardrail applies to — pass
   * `OpenRouter.ApiKey` `hash` outputs. When set (including `[]`), the
   * guardrail's key assignments converge to exactly this list; when
   * omitted, assignments made outside Alchemy are left alone.
   */
  apiKeys?: string[];
  /**
   * Workspace that owns the guardrail. Changing it replaces the guardrail.
   * @default the account's default workspace
   */
  workspaceId?: string;
}

export interface GuardrailAttributes {
  /** Guardrail identifier. */
  id: string;
  /** Observed name. */
  name: string;
  /** Observed description. */
  description: string | undefined;
  /** Workspace that owns the guardrail, or `undefined` for a legacy unscoped guardrail. */
  workspaceId: string | undefined;
  /** Spending limit in USD. */
  limitUsd: number | undefined;
  /** Budget reset interval. */
  resetInterval: string | undefined;
  /** Whether BYOK spend counts toward the budget. */
  includeByokInBudgets: boolean;
  /** Allowed provider IDs. */
  allowedProviders: string[] | undefined;
  /** Ignored provider IDs. */
  ignoredProviders: string[] | undefined;
  /** Allowed models, as canonical slugs. */
  allowedModels: string[] | undefined;
  /** Ignored models, as canonical slugs. */
  ignoredModels: string[] | undefined;
  /** Allowed ingress regions. */
  allowedDataRegions: string[] | undefined;
  /** Hashes of the API keys currently assigned to the guardrail. */
  apiKeys: string[];
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

export interface Guardrail extends Resource<
  "OpenRouter.Guardrail",
  GuardrailProps,
  GuardrailAttributes,
  never,
  Providers
> {}

/**
 * An OpenRouter guardrail — a policy that restricts which providers and
 * models assigned API keys may use, caps their combined spend, enforces
 * zero data retention, and applies content filters.
 *
 * A guardrail enforces nothing until keys are assigned to it. Pass
 * `OpenRouter.ApiKey` hashes in `apiKeys` and Alchemy keeps the assignments
 * in sync. Every setting except `workspaceId` is updated in place.
 * Deploying requires a management key (`OPENROUTER_MANAGEMENT_KEY`).
 *
 * ### Restricting models and providers
 * **Example:** Allow only Anthropic and OpenAI
 * ```typescript
 * const policy = yield* OpenRouter.Guardrail("AgentPolicy", {
 *   allowedProviders: ["anthropic", "openai"],
 *   enforceZdr: true,
 * });
 * ```
 *
 * ### Budgets
 * **Example:** Shared daily budget for a fleet of agent keys
 * ```typescript
 * const planner = yield* OpenRouter.ApiKey("Planner", { limit: 10, limitReset: "daily" });
 * const coder = yield* OpenRouter.ApiKey("Coder", { limit: 20, limitReset: "daily" });
 *
 * yield* OpenRouter.Guardrail("Fleet", {
 *   limitUsd: 25,
 *   resetInterval: "daily",
 *   allowedModels: ["anthropic/claude-sonnet-4.5", "openai/gpt-4o-mini"],
 *   apiKeys: [planner.hash, coder.hash],
 * });
 * ```
 *
 * ### Content filters
 * **Example:** Redact PII and block prompt injection
 * ```typescript
 * yield* OpenRouter.Guardrail("Pii", {
 *   contentFilterBuiltins: [
 *     { slug: "email", action: "redact" },
 *     { slug: "regex-prompt-injection", action: "block", scanScope: "user_only" },
 *   ],
 * });
 * ```
 *
 * @resource
 * @product OpenRouter
 * @category AI
 */
export const Guardrail = Resource<Guardrail>("OpenRouter.Guardrail");

type ObservedGuardrail =
  | OpenRouter.GetGuardrailResponseData
  | OpenRouter.CreateGuardrailResponseData
  | OpenRouter.UpdateGuardrailResponseData;

/** Mutable guardrail fields, in the API's wire shape. */
type GuardrailFields = Omit<OpenRouter.UpdateGuardrailRequest, "id">;

/** Desired wire state; `null` clears a field. */
const desiredFields = (news: GuardrailProps, name: string) => {
  const zdr = news.enforceZdr ?? null;
  return {
    name,
    description: news.description ?? null,
    limit_usd: news.limitUsd ?? null,
    reset_interval: news.resetInterval ?? null,
    include_byok_in_budgets: news.includeByokInBudgets ?? false,
    allowed_providers: news.allowedProviders ?? null,
    ignored_providers: news.ignoredProviders ?? null,
    allowed_models: news.allowedModels ?? null,
    ignored_models: news.ignoredModels ?? null,
    allowed_data_regions: news.allowedDataRegions ?? null,
    enforce_zdr_anthropic: zdr,
    enforce_zdr_openai: zdr,
    enforce_zdr_google: zdr,
    enforce_zdr_xai: zdr,
    enforce_zdr_other: zdr,
    enable_paid_model_training: news.enablePaidModelTraining ?? null,
    enable_free_model_training: news.enableFreeModelTraining ?? null,
    enable_free_model_publication: news.enableFreeModelPublication ?? null,
    content_filters:
      news.contentFilters?.map((filter): OpenRouter.ContentFilterEntry => ({
        pattern: filter.pattern,
        action: filter.action,
        label: filter.label ?? null,
      })) ?? null,
    content_filter_builtins:
      news.contentFilterBuiltins?.map((filter): OpenRouter.ContentFilterBuiltinEntryInput => ({
        slug: filter.slug,
        action: filter.action,
        ...(filter.scanScope !== undefined ? { scan_scope: filter.scanScope } : {}),
      })) ?? null,
  } satisfies GuardrailFields;
};

type DesiredFields = ReturnType<typeof desiredFields>;

/** Project observed state onto the desired shape so the two compare field by field. */
const observedFields = (observed: ObservedGuardrail): DesiredFields => ({
  name: observed.name,
  description: observed.description ?? null,
  limit_usd: observed.limit_usd ?? null,
  reset_interval: observed.reset_interval ?? null,
  include_byok_in_budgets: observed.include_byok_in_budgets,
  allowed_providers: observed.allowed_providers ?? null,
  ignored_providers: observed.ignored_providers ?? null,
  allowed_models: observed.allowed_models ?? null,
  ignored_models: observed.ignored_models ?? null,
  allowed_data_regions: observed.allowed_data_regions ?? null,
  enforce_zdr_anthropic: observed.enforce_zdr_anthropic ?? null,
  enforce_zdr_openai: observed.enforce_zdr_openai ?? null,
  enforce_zdr_google: observed.enforce_zdr_google ?? null,
  enforce_zdr_xai: observed.enforce_zdr_xai ?? null,
  enforce_zdr_other: observed.enforce_zdr_other ?? null,
  enable_paid_model_training: observed.enable_paid_model_training ?? null,
  enable_free_model_training: observed.enable_free_model_training ?? null,
  enable_free_model_publication: observed.enable_free_model_publication ?? null,
  content_filters:
    observed.content_filters?.map((filter): OpenRouter.ContentFilterEntry => ({
      pattern: filter.pattern,
      action: filter.action,
      label: filter.label ?? null,
    })) ?? null,
  // `label` on builtins is system-assigned; drop it before comparing.
  content_filter_builtins:
    observed.content_filter_builtins?.map((filter): OpenRouter.ContentFilterBuiltinEntryInput => ({
      slug: filter.slug,
      action: filter.action,
      ...(filter.scan_scope !== undefined ? { scan_scope: filter.scan_scope } : {}),
    })) ?? null,
});

/** Fields of `desired` whose value differs from `observed`. */
const delta = (desired: DesiredFields, observed: DesiredFields): GuardrailFields => {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(desired) as Array<keyof DesiredFields>) {
    if (!deepEqual(desired[key], observed[key])) patch[key] = desired[key];
  }
  // OpenRouter rejects a request that sets only one of the budget pair.
  if ("limit_usd" in patch || "reset_interval" in patch) {
    patch.limit_usd = desired.limit_usd;
    patch.reset_interval = desired.reset_interval;
  }
  return patch as GuardrailFields;
};

const toAttributes = (observed: ObservedGuardrail, apiKeys: string[]): GuardrailAttributes => ({
  id: observed.id,
  name: observed.name,
  description: observed.description ?? undefined,
  workspaceId: observed.workspace_id ?? undefined,
  limitUsd: observed.limit_usd ?? undefined,
  resetInterval: observed.reset_interval ?? undefined,
  includeByokInBudgets: observed.include_byok_in_budgets,
  allowedProviders: observed.allowed_providers ? [...observed.allowed_providers] : undefined,
  ignoredProviders: observed.ignored_providers ? [...observed.ignored_providers] : undefined,
  allowedModels: observed.allowed_models ? [...observed.allowed_models] : undefined,
  ignoredModels: observed.ignored_models ? [...observed.ignored_models] : undefined,
  allowedDataRegions: observed.allowed_data_regions
    ? [...observed.allowed_data_regions]
    : undefined,
  apiKeys: [...apiKeys].sort(),
  createdAt: observed.created_at,
});

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

export const GuardrailProvider = () =>
  Provider.effect(
    Guardrail,
    Effect.gen(function* () {
      const createGuardrail = yield* OpenRouter.createGuardrail;
      const getGuardrail = yield* OpenRouter.getGuardrail;
      const updateGuardrail = yield* OpenRouter.updateGuardrail;
      const deleteGuardrail = yield* OpenRouter.deleteGuardrail;
      const listAssignments = yield* OpenRouter.listGuardrailKeyAssignments;
      const assignKeys = yield* OpenRouter.bulkAssignKeysToGuardrail;
      const unassignKeys = yield* OpenRouter.bulkUnassignKeysFromGuardrail;

      const observe = (id: string) =>
        getGuardrail({ id }).pipe(
          Effect.map((response) => response.data),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );

      /** Every key hash assigned to the guardrail (offset-paginated, bounded). */
      const observeAssignments = Effect.fn(function* (id: string) {
        const hashes: string[] = [];
        for (let page = 0; page < MAX_PAGES; page++) {
          const response = yield* listAssignments({
            id,
            offset: page * PAGE_SIZE,
            limit: PAGE_SIZE,
          });
          for (const assignment of response.data) hashes.push(assignment.key_hash);
          if (response.data.length < PAGE_SIZE || hashes.length >= response.total_count) break;
        }
        return hashes;
      });

      return {
        stables: ["id", "workspaceId", "createdAt"],
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (output === undefined) return undefined;
          if (news.workspaceId !== undefined && news.workspaceId !== output.workspaceId) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output }) {
          if (output === undefined) return undefined;
          const observed = yield* observe(output.id);
          if (observed === undefined) return undefined;
          return toAttributes(observed, yield* observeAssignments(observed.id));
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, output }) {
          const name = news.name ?? output?.name ?? (yield* createPhysicalName({ id }));
          const desired = desiredFields(news, name);

          // Observe
          let observed: ObservedGuardrail | undefined = output
            ? yield* observe(output.id)
            : undefined;

          // Ensure — create with only the fields the user declared.
          if (observed === undefined) {
            const { name: _name, ...rest } = desired;
            const declared = Object.fromEntries(
              Object.entries(rest).filter(([, value]) => value !== null),
            ) as Omit<OpenRouter.CreateGuardrailRequest, "name">;
            observed = (yield* createGuardrail({
              ...declared,
              name,
              workspace_id: news.workspaceId,
            }).pipe(OpenRouter.Retry.none)).data;
          }

          // Sync settings — PATCH only fields that differ from observed state.
          const patch = delta(desired, observedFields(observed));
          if (Object.keys(patch).length > 0) {
            observed = (yield* updateGuardrail({ id: observed.id, ...patch })).data;
          }

          // Sync key assignments against the observed assignment list.
          let assigned = yield* observeAssignments(observed.id);
          const managed = news.apiKeys ?? (olds?.apiKeys !== undefined ? [] : undefined);
          if (managed !== undefined) {
            const want = new Set(managed);
            const have = new Set(assigned);
            const toAssign = [...want].filter((hash) => !have.has(hash));
            const toUnassign = [...have].filter((hash) => !want.has(hash));
            if (toAssign.length > 0) {
              // A just-created key can briefly 404 on assignment.
              yield* assignKeys({ id: observed.id, key_hashes: toAssign }).pipe(
                Effect.retry({
                  while: (error) => error._tag === "NotFound",
                  schedule: Schedule.exponential("500 millis"),
                  times: 6,
                }),
              );
            }
            if (toUnassign.length > 0) {
              yield* unassignKeys({ id: observed.id, key_hashes: toUnassign }).pipe(
                Effect.catchTag("NotFound", () => Effect.void),
              );
            }
            if (toAssign.length > 0 || toUnassign.length > 0) {
              assigned = yield* observeAssignments(observed.id);
            }
          }

          return toAttributes(observed, assigned);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteGuardrail({ id: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
      };
    }),
  );
