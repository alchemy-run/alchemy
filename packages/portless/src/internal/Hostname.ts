import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
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
 * Validates a name with Portless's own grammar and appends the TLD (`.localhost`,
 * or `.local` in LAN mode).
 * Fails with {@link HostnameInvalid} when Portless can't serve it.
 */
export const hostnameOf = (name: string, tld = "localhost") =>
  Effect.try({
    try: () => parseHostname(name, tld),
    catch: (cause) =>
      new HostnameInvalid({
        hostname: name,
        reason: Predicate.hasProperty(cause, "message")
          ? String(cause.message)
          : "it is not a valid DNS name",
      }),
  });

/** The HTTPS origin the proxy serves a hostname on. */
export const originOf = (hostname: string, proxyPort: number) =>
  formatUrl(hostname, proxyPort, true);
