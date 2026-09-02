import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as DNS from "../../Cloudflare/DNS/index.ts";
import { DurableObject } from "../../Cloudflare/Workers/DurableObject.ts";
import { Worker } from "../../Cloudflare/Workers/Worker.ts";
import type { RelaySession } from "./relay.worker.ts";

/**
 * Deploys an Alchemy dev relay: the Worker + Durable Object in
 * `relay.worker.ts`, a wildcard DNS record, and Worker routes on a zone you
 * own, so that `alchemy dev --relay https://<domain>` gives every local
 * resource a stable `https://<name>.<namespace>.<domain>` URL over a single
 * WebSocket from the dev sidecar.
 *
 * ### Deploying a relay
 * **Example:** Relay on `dev.example.com`
 * ```typescript
 * const relay = yield* Alchemy.Local.Relay.DevRelay("DevRelay", {
 *   zoneId: zone.zoneId,
 *   domain: "dev.example.com",
 *   token: Config.redacted("DEV_RELAY_TOKEN"),
 * });
 * // alchemy dev --relay https://dev.example.com
 * ```
 *
 * Two-level hostnames (`api.sam.dev.example.com`) need a certificate that
 * covers `*.sam.dev.example.com` — Advanced Certificate Manager (or Total
 * TLS) on the zone; Universal SSL alone only covers one wildcard level.
 */
export interface DevRelayProps {
  /** Zone the relay domain lives in. */
  readonly zoneId: string;
  /** Public domain: hosts are `<name>.<namespace>.<domain>` (e.g. `dev.example.com`). */
  readonly domain: string;
  /** Shared bearer token connectors must present. Omit to accept any connector (test relays only). */
  readonly token?: Redacted.Redacted<string> | string;
  /**
   * Scheme announced to connectors and used in the URLs they print.
   * @default "https"
   */
  readonly scheme?: "https" | "http";
  /** Worker script name override. */
  readonly name?: string;
}

export const DevRelay = Effect.fn("DevRelay")(function* (
  id: string,
  props: DevRelayProps,
) {
  const Sessions = DurableObject<RelaySession>(`${id}Sessions`, {
    className: "RelaySession",
  });
  const worker = yield* Worker(id, {
    name: props.name,
    main: import.meta.resolve(
      import.meta.url.endsWith(".ts")
        ? "./relay.worker.ts"
        : "./relay.worker.js",
      import.meta.url,
    ),
    env: {
      SESSIONS: Sessions,
      RELAY_DOMAIN: props.domain,
      RELAY_SCHEME: props.scheme ?? "https",
      ...(props.token !== undefined
        ? {
            RELAY_TOKEN: Redacted.isRedacted(props.token)
              ? props.token
              : Redacted.make(props.token),
          }
        : {}),
    },
    routes: [
      // The connect endpoint at the domain apex …
      { pattern: `${props.domain}/*`, zoneId: props.zoneId },
      // … and every `<name>.<namespace>.<domain>` (the leading wildcard
      // matches across dots).
      { pattern: `*.${props.domain}/*`, zoneId: props.zoneId },
    ],
  });
  // Proxied placeholder records so the routes have DNS to attach to.
  const apex = yield* DNS.Record(`${id}Apex`, {
    zoneId: props.zoneId,
    name: props.domain,
    type: "AAAA",
    content: "100::",
    proxied: true,
  });
  const wildcard = yield* DNS.Record(`${id}Wildcard`, {
    zoneId: props.zoneId,
    name: `*.${props.domain}`,
    type: "AAAA",
    content: "100::",
    proxied: true,
  });
  return {
    worker,
    apex,
    wildcard,
    /** Base URL to pass to `alchemy dev --relay`. */
    url: `${props.scheme ?? "https"}://${props.domain}`,
  };
});
