import * as Effect from "effect/Effect";
import { kebabCase } from "effect/String";
import { formatUrl, parseHostname } from "portless";
import { HostnameInvalid } from "../Errors.ts";

/**
 * A stage as one DNS label: Alchemy's default `dev_alice` becomes `dev-alice`,
 * and a stage that is already a label stays as it is.
 */
export const stageLabel = (stage: string) =>
  stage
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * The name a resource registers with Portless, before `.localhost` is added:
 * `<stage>.<kebab(id)>.<domain>`.
 */
export const routedName = (id: string, stage: string, domain: string) =>
  `${stageLabel(stage)}.${kebabCase(id)}.${domain}`;

/**
 * Validates a name with Portless's own grammar and appends `.localhost`. Throws
 * {@link HostnameInvalid}: for the places that can only throw, such as the
 * function an Output maps with.
 */
export const hostnameOrThrow = (name: string) => {
  try {
    return parseHostname(name);
  } catch (cause) {
    throw new HostnameInvalid({
      hostname: name,
      reason: cause instanceof Error ? cause.message : "it is not a valid DNS name",
    });
  }
};

/** {@link hostnameOrThrow} as an Effect that fails with {@link HostnameInvalid}. */
export const hostnameOf = (name: string) =>
  Effect.try({
    try: () => hostnameOrThrow(name),
    catch: (error) =>
      error instanceof HostnameInvalid
        ? error
        : new HostnameInvalid({ hostname: name, reason: String(error) }),
  });

/** The HTTPS origin the proxy serves a hostname on. */
export const originOf = (hostname: string, proxyPort: number) =>
  formatUrl(hostname, proxyPort, true);
