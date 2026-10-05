import type * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import { containsValue, sameValue } from "./Common.ts";

export type RaiPolicyMode = cognitiveservices.RaiPolicyMode;
export type RaiContentSource = cognitiveservices.RaiPolicyContentSource;

export interface RaiContentFilter {
  /** Filter name, e.g. `Hate`, `Sexual`, `Violence`, `Selfharm`, `Jailbreak`, `Protected Material Text`. */
  name: string;
  /** Whether the filter runs. */
  enabled: boolean;
  /** Whether a match blocks the request or response. */
  blocking: boolean;
  /** Severity at or above which content is filtered (severity filters only). */
  severityThreshold?: "Low" | "Medium" | "High";
  /** Whether the filter applies to prompts or completions. */
  source: RaiContentSource;
}

export interface RaiCustomBlocklist {
  /** Name of a `CognitiveServices.RaiBlocklist` in the same account (or subscription). */
  blocklistName: string;
  /** Whether a match blocks the request or response. */
  blocking: boolean;
  /** Whether the blocklist applies to prompts or completions. */
  source: RaiContentSource;
}

export interface RaiSafetyProvider {
  /** Name of a `CognitiveServices.RaiExternalSafetyProvider`. */
  safetyProviderName: string;
  /** Whether a match blocks the request or response. */
  blocking: boolean;
  /** Whether the provider applies to prompts or completions. */
  source: RaiContentSource;
}

export interface RaiPolicySettings {
  /**
   * Built-in policy this policy derives from.
   * @default "Microsoft.DefaultV2"
   */
  basePolicyName?: string;
  /** Filtering mode (`Default`, `Deferred`, `Blocking`, `Asynchronous_filter`). */
  mode?: RaiPolicyMode;
  /** Content filters. */
  contentFilters?: RaiContentFilter[];
  /** Custom blocklists applied by the policy. */
  customBlocklists?: RaiCustomBlocklist[];
  /** External safety providers applied by the policy. */
  safetyProviders?: RaiSafetyProvider[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export const desiredRaiPolicy = (
  settings: RaiPolicySettings,
): cognitiveservices.RaiPolicyProperties => ({
  basePolicyName: settings.basePolicyName ?? "Microsoft.DefaultV2",
  mode: settings.mode,
  contentFilters: settings.contentFilters,
  customBlocklists: settings.customBlocklists,
  safetyProviders: settings.safetyProviders,
});

const keyOf = (item: { name?: string; source?: string }) =>
  `${item.name?.toLowerCase()}|${item.source}`;

/**
 * Whether the observed policy already matches the desired settings.
 * Azure fills in filters the user did not list, so only the listed ones are
 * compared.
 */
export const raiPolicyMatches = (
  observed: cognitiveservices.RaiPolicyProperties | undefined,
  desired: cognitiveservices.RaiPolicyProperties,
) => {
  if (observed === undefined) return false;
  if (observed.basePolicyName !== desired.basePolicyName) return false;
  if (desired.mode !== undefined && observed.mode !== desired.mode) {
    return false;
  }
  const filters = new Map(
    (observed.contentFilters ?? []).map((filter) => [keyOf(filter), filter]),
  );
  for (const filter of desired.contentFilters ?? []) {
    const match = filters.get(keyOf(filter));
    if (!containsValue(match as Record<string, unknown>, { ...filter })) {
      return false;
    }
  }
  const sortBy =
    <T>(key: (item: T) => string) =>
    (items: ReadonlyArray<T> | undefined) =>
      [...(items ?? [])].sort((a, b) => key(a).localeCompare(key(b)));
  const blocklists = sortBy<cognitiveservices.CustomBlocklistConfig>(
    (b) => `${b.blocklistName}|${b.source}`,
  );
  if (
    desired.customBlocklists !== undefined &&
    !sameValue(
      blocklists(observed.customBlocklists),
      blocklists(desired.customBlocklists),
    )
  ) {
    return false;
  }
  const providers = sortBy<cognitiveservices.SafetyProviderConfig>(
    (p) => `${p.safetyProviderName}|${p.source}`,
  );
  if (
    desired.safetyProviders !== undefined &&
    !sameValue(
      providers(observed.safetyProviders),
      providers(desired.safetyProviders),
    )
  ) {
    return false;
  }
  return true;
};
