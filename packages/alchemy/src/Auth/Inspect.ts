import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import type { AuthProviders, ProviderDetailLine } from "./AuthProvider.ts";
import type { ProviderConfig } from "./Profile.ts";

/**
 * What a connected provider looks like right now. Establishing this means
 * decoding the stored config and asking the provider to describe itself,
 * either of which can fail — which is the point: a profile listing has to
 * show a broken connection rather than fail because of one.
 */
export interface ProviderConnection {
  readonly name: string;
  /** How credentials were supplied (`oauth`, `api-token`, …). */
  readonly method: string;
  readonly status: "connected" | "needs-reauth" | "invalid" | "unavailable";
  readonly details: ReadonlyArray<ProviderDetailLine>;
  /** Present whenever `status` is anything but `connected`. */
  readonly diagnostic?: {
    readonly severity: "warning" | "error";
    readonly code: string;
    readonly message: string;
  };
}

const broken = (
  name: string,
  method: string,
  severity: "warning" | "error",
  code: string,
  message: string,
): ProviderConnection => ({
  name,
  method,
  status: severity === "warning" ? "needs-reauth" : "invalid",
  details: [],
  diagnostic: { severity, code, message },
});

/**
 * Resolve one stored provider's live connection status. Never fails: every
 * way this can go wrong is reported as a `status` + `diagnostic` so a listing
 * can show the whole profile.
 */
export const inspectProvider = Effect.fn("inspectProvider")(function* (
  profile: string,
  name: string,
  config: ProviderConfig,
  registered: AuthProviders["Service"],
) {
  const provider = registered[name];
  if (provider === undefined) {
    return {
      name,
      method: config.method,
      status: "unavailable",
      details: [],
      diagnostic: {
        severity: "warning",
        code: "provider.unregistered",
        message: `Provider '${name}' is not registered.`,
      },
    } satisfies ProviderConnection;
  }

  const decoded = yield* Effect.result(provider.decodeConfig(profile, config));
  if (Result.isFailure(decoded)) {
    return broken(
      name,
      config.method,
      "error",
      "provider.invalid-config",
      decoded.failure.message,
    );
  }

  const details = yield* Effect.result(
    provider.details(profile, decoded.success),
  );
  if (Result.isSuccess(details)) {
    return {
      name,
      method: config.method,
      status: "connected",
      details: details.success.lines,
    } satisfies ProviderConnection;
  }

  // A provider that can no longer prove who it is has expired credentials,
  // which the user can fix by re-authenticating — not a broken config.
  const needsReauth = Predicate.isTagged("NeedsReauth")(details.failure);
  return broken(
    name,
    config.method,
    needsReauth ? "warning" : "error",
    needsReauth ? "provider.needs-reauth" : "provider.details-failed",
    details.failure.message,
  );
});
