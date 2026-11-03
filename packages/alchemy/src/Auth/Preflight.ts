/**
 * Pre-flight check of a stack's stored credentials, run before a deploy is
 * planned. Each auth provider that implements `preflight` gets its own
 * resources (matched by the resource Type's leading segment,
 * `"Cloudflare.D1Database"` → `"Cloudflare"`) and the active profile's stored
 * config, and fails when that config cannot manage them, e.g. an OAuth grant
 * missing a scope. Without it the run only fails later, on the first cloud
 * call, with a generic authorization error that names neither the resource
 * nor the grant.
 *
 * The check never calls the cloud and never blocks on its own lookups:
 * environment credentials, CI, a missing profile entry or an unreadable
 * config all skip it, and the run's normal credential resolution reports
 * those as it does today.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AuthProviders, type PreflightResource } from "./AuthProvider.ts";
import { ProfileStore, SuppressMissingProviderConfig } from "./Profile.ts";
import { resolveProviderConfig } from "./Resolve.ts";

/** `"Cloudflare.Access.Application"` → `"Cloudflare"` (the auth-provider name). */
const cloudOf = (type: string): string => type.split(".")[0] ?? type;

/** Run every registered auth provider's `preflight` against the stack resources it owns. */
export const preflightCredentials = Effect.fn("Alchemy.preflightCredentials")(function* (
  resources: ReadonlyArray<PreflightResource>,
) {
  const registry = Option.getOrUndefined(yield* Effect.serviceOption(AuthProviders));
  const profile = Option.getOrUndefined(yield* Effect.serviceOption(ProfileStore));
  if (registry === undefined || profile === undefined) return;
  const byProvider = new Map<string, PreflightResource[]>();
  for (const resource of resources) {
    const provider = cloudOf(resource.Type);
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), resource]);
  }
  for (const [provider, owned] of byProvider) {
    const auth = registry[provider];
    if (auth?.preflight === undefined) continue;
    const resolved = yield* resolveProviderConfig(provider).pipe(
      Effect.provideService(AuthProviders, registry),
      Effect.provideService(ProfileStore, profile),
      Effect.provideService(SuppressMissingProviderConfig, true),
      Effect.option,
    );
    if (Option.isNone(resolved)) continue;
    // Environment credentials (CI or exported variables) carry no profile config.
    const { profileName, config } = resolved.value;
    if (profileName === undefined || config === undefined) continue;
    yield* auth.preflight(profileName, config, owned);
  }
});
