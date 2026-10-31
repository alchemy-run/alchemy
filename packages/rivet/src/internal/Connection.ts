/**
 * How a Rivet resource reaches its control plane: the API endpoint and the
 * admin token, carried on the resource's props so every resource talks to
 * the control plane it was declared against.
 *
 * @internal not exported from the Rivet barrel.
 */
import * as Rivet from "@distilled.cloud/rivet";
import * as Effect from "effect/Effect";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

export interface ConnectionProps {
  /** The control plane's API URL, e.g. `https://rivet.example.com`. */
  endpoint: string;
  /** The control plane's admin token. */
  token: Redacted.Redacted<string>;
}

/**
 * Provide the Rivet SDK credentials for one control plane, and wait out a
 * control plane that is still starting: it refuses connections for a few
 * seconds, then reports healthy about a minute before its storage accepts
 * commands (`StorageOverloaded`). Behind a load balancer the same window
 * shows up as 502/503/504 until its instances boot and pass health checks,
 * which takes a few minutes on fresh EC2 instances. A resource reconciled
 * right after its control plane starts would otherwise fail.
 */
export const withConnection =
  (connection: ConnectionProps) =>
  <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.retry({
        while: (error) =>
          error._tag === "StorageOverloaded" ||
          error._tag === "BadGateway" ||
          error._tag === "ServiceUnavailable" ||
          error._tag === "GatewayTimeout" ||
          (HttpClientError.isHttpClientError(error) && error.reason._tag === "TransportError"),
        schedule: Schedule.spaced("5 seconds"),
        times: 72,
      }),
      Effect.provide(Rivet.credentials({ token: connection.token, endpoint: connection.endpoint })),
    );
