import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { collectProviderMetadata } from "../Provider.ts";
import type { CompiledStack } from "../Stack.ts";
import { AuthProviders, type PreflightFinding } from "./AuthProvider.ts";
import { ALCHEMY_PROFILE, AlchemyProfile } from "./Profile.ts";

/**
 * Required-vs-granted credential preflight, run before deploy/plan/destroy.
 *
 * Collects the compiled stack's provider metadata (exact mode — only the
 * resource types the stack declares), then asks each registered auth provider
 * to diff its own cloud's requirements against the active profile's grants
 * (see `AuthProviderImpl.preflight`). Findings are rendered as warnings; the
 * run proceeds — a stale grant analysis must never block a deploy that would
 * have succeeded.
 *
 * Never fails: any error in the analysis is logged at debug level and
 * swallowed.
 */
export const preflightStack = (
  stack: CompiledStack,
): Effect.Effect<void, never, AlchemyProfile> =>
  Effect.gen(function* () {
    const metadata = collectProviderMetadata(
      stack.services,
      Object.values(stack.resources).map((r) => r.Type),
    );
    if (metadata.used === undefined || metadata.used.size === 0) {
      return;
    }

    const registry = yield* Effect.serviceOption(AuthProviders);
    if (Option.isNone(registry)) {
      return;
    }

    const profileName = yield* ALCHEMY_PROFILE;
    const profiles = yield* AlchemyProfile;
    const entry = yield* profiles.getProfile(profileName);
    if (entry == null) {
      return;
    }

    const findings: { provider: string; finding: PreflightFinding }[] = [];
    for (const provider of Object.values(registry.value)) {
      const config = entry[provider.name];
      if (config == null || provider.preflight == null) {
        continue;
      }
      const results = yield* provider.preflight(profileName, config, metadata);
      for (const finding of results) {
        findings.push({ provider: provider.name, finding });
      }
    }

    if (findings.length === 0) {
      return;
    }

    const lines = findings.map(
      ({ provider, finding }) =>
        `  - [${provider}] missing ${finding.missing} (needed by ${finding.resourceTypes.join(", ")})`,
    );
    const remediations = [
      ...new Set(findings.map(({ finding }) => finding.remediation)),
    ].map((r) => `  → ${r}`);
    yield* Console.warn(
      `⚠ Profile "${profileName}" may be missing grants required by this stack:\n` +
        `${lines.join("\n")}\n${remediations.join("\n")}`,
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logDebug("credential preflight skipped", cause),
    ),
  );
