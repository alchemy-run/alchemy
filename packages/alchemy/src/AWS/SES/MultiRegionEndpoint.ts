import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

/**
 * The lifecycle status of a multi-region endpoint: `CREATING`, `READY`,
 * `FAILED`, or `DELETING`.
 */
export type MultiRegionEndpointStatus = sesv2.Status;

/**
 * A single route in a multi-region endpoint — a secondary AWS region across
 * which the endpoint splits sending traffic.
 */
export interface MultiRegionEndpointRoute {
  /** The AWS region this route sends from (e.g. `"eu-west-1"`). */
  region: string;
}

export interface MultiRegionEndpointDetails {
  /**
   * The regions the endpoint routes traffic across. The primary region is the
   * region where the resource is created; the routes provide the secondary
   * regions. Sending traffic is split across all of them.
   */
  routesDetails: MultiRegionEndpointRoute[];
}

export interface MultiRegionEndpointProps {
  /**
   * Name of the multi-region endpoint. If omitted, a deterministic physical
   * name is generated from the app, stage, and logical ID. Changing the name
   * replaces the endpoint.
   */
  endpointName?: string;
  /**
   * The endpoint's routing configuration. There is no update API, so any
   * change to the routes replaces the endpoint.
   */
  details: MultiRegionEndpointDetails;
}

export interface MultiRegionEndpoint extends Resource<
  "AWS.SES.MultiRegionEndpoint",
  MultiRegionEndpointProps,
  {
    /** Name of the multi-region endpoint. */
    endpointName: string;
    /** Opaque endpoint identifier assigned by SES. */
    endpointId: string;
    /**
     * The endpoint's provisioning status at the time reconcile returned.
     * Provisioning is asynchronous and starts as `CREATING`; the endpoint is
     * not usable until it reaches `READY`. Reconcile does NOT wait for
     * `READY` — poll `getMultiRegionEndpoint` downstream if you need to block
     * on readiness.
     */
    status: MultiRegionEndpointStatus;
  },
  never,
  Providers
> {}

/**
 * An Amazon SES v2 multi-region endpoint (global endpoint) — a single sending
 * endpoint that splits email traffic across a primary region (where the
 * endpoint is created) and one or more secondary regions, improving
 * resilience and deliverability.
 *
 * :::note
 * Provisioning is asynchronous and can take a while: creation returns
 * immediately with status `CREATING`, and the endpoint only becomes usable
 * once it reaches `READY`. This resource does **not** wait for `READY` — the
 * `status` attribute reflects the value observed when reconcile returned.
 * Poll `getMultiRegionEndpoint` yourself if you need to block on readiness.
 * :::
 *
 * There is no update API, so any change to the name or routes replaces the
 * endpoint.
 * @resource
 * @section Creating Endpoints
 * @example Two-Region Endpoint
 * ```typescript
 * import * as SES from "alchemy/AWS/SES";
 *
 * // The primary region is wherever the stack deploys; the route adds a
 * // secondary region.
 * const endpoint = yield* SES.MultiRegionEndpoint("Global", {
 *   details: { routesDetails: [{ region: "eu-west-1" }] },
 * });
 * ```
 */
export const MultiRegionEndpoint = Resource<MultiRegionEndpoint>(
  "AWS.SES.MultiRegionEndpoint",
);

const sameRoutes = (
  a: ReadonlyArray<MultiRegionEndpointRoute> | undefined,
  b: ReadonlyArray<MultiRegionEndpointRoute> | undefined,
): boolean => {
  const key = (routes: ReadonlyArray<MultiRegionEndpointRoute> | undefined) =>
    JSON.stringify([...(routes ?? [])].map((r) => r.region).sort());
  return key(a) === key(b);
};

export const MultiRegionEndpointProvider = () =>
  Provider.effect(
    MultiRegionEndpoint,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<MultiRegionEndpointProps, "endpointName">,
      ) {
        return (
          props.endpointName ??
          (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const getEndpoint = Effect.fn(function* (name: string) {
        return yield* sesv2
          .getMultiRegionEndpoint({ EndpointName: name })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return MultiRegionEndpoint.Provider.of({
        stables: ["endpointName", "endpointId"],

        // Account/region-scoped: enumerate every endpoint so leaked test
        // resources are cleaned by nuke.
        list: () =>
          Effect.gen(function* () {
            const pages = yield* sesv2.listMultiRegionEndpoints
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.MultiRegionEndpoints ?? [])
              .flatMap((entry) =>
                entry.EndpointName && entry.EndpointId
                  ? [
                      {
                        endpointName: entry.EndpointName,
                        endpointId: entry.EndpointId,
                        status: entry.Status ?? "CREATING",
                      },
                    ]
                  : [],
              );
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.endpointName ?? (yield* createName(id, olds ?? {}));
          const found = yield* getEndpoint(name);
          if (!found || !found.EndpointId) return undefined;
          return {
            endpointName: name,
            endpointId: found.EndpointId,
            status: found.Status ?? "CREATING",
          };
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          // No update API: a rename or any routing change replaces the
          // endpoint.
          if (
            oldName !== newName ||
            !sameRoutes(
              olds?.details?.routesDetails,
              news.details.routesDetails,
            )
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.endpointName ?? (yield* createName(id, news));

          // 1. OBSERVE — cloud state is authoritative.
          let observed = yield* getEndpoint(name);

          if (observed === undefined) {
            // 2. ENSURE — create; AlreadyExists is a race, not a failure.
            //    Provisioning is asynchronous: creation returns CREATING and we
            //    deliberately do NOT wait for READY (that exceeds the polling
            //    budget; downstream consumers poll if they need readiness).
            yield* sesv2
              .createMultiRegionEndpoint({
                EndpointName: name,
                Details: {
                  RoutesDetails: news.details.routesDetails.map((route) => ({
                    Region: route.region,
                  })),
                },
              })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () =>
                  Effect.succeed({}),
                ),
              );
            observed = yield* getEndpoint(name);
          }

          if (observed === undefined || !observed.EndpointId) {
            return yield* Effect.fail(
              new Error(
                `SES multi-region endpoint ${name} was not found after create`,
              ),
            );
          }

          yield* session.note(observed.EndpointId);
          return {
            endpointName: name,
            endpointId: observed.EndpointId,
            status: observed.Status ?? "CREATING",
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteMultiRegionEndpoint is idempotent for a missing endpoint.
          yield* sesv2
            .deleteMultiRegionEndpoint({ EndpointName: output.endpointName })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      });
    }),
  );
