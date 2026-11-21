import * as Effect from "effect/Effect";
import { HostnameClaimed } from "../Errors.ts";

interface Claim {
  readonly owner: string;
  readonly fqn: string;
  readonly token: symbol;
}

/**
 * The hostnames this process routes, by the resource instance that holds each.
 * A route's owner in Portless is a process, so two resources of one process
 * can't be told apart by the route store: this is what rejects the second.
 * It lives at module scope because the process, not a session, owns the routes.
 */
const held = new Map<string, Claim>();

export interface Held {
  /** Gives the hostname up. False when a newer claim of the same resource replaced this one. */
  readonly release: Effect.Effect<boolean>;
}

/**
 * Claims a hostname for one resource instance. Claiming it again for the same
 * instance (a restart, a reload) replaces the earlier claim.
 */
export const claim = (
  hostname: string,
  owner: { readonly instanceId: string; readonly fqn: string },
) =>
  Effect.suspend(() => {
    const existing = held.get(hostname);
    if (existing !== undefined && existing.owner !== owner.instanceId) {
      return Effect.fail(new HostnameClaimed({ hostname, fqn: existing.fqn, pid: undefined }));
    }
    const token = Symbol(hostname);
    held.set(hostname, { owner: owner.instanceId, fqn: owner.fqn, token });
    return Effect.succeed<Held>({
      release: Effect.sync(() => {
        if (held.get(hostname)?.token !== token) return false;
        held.delete(hostname);
        return true;
      }),
    });
  });

/** Gives a hostname up for the resource instance that holds it, such as an alias that moved to another name. */
export const release = (hostname: string, instanceId: string) =>
  Effect.sync(() => {
    if (held.get(hostname)?.owner === instanceId) held.delete(hostname);
  });
