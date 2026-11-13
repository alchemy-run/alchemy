import * as DO from "@distilled.cloud/digitalocean";
import type { CdnEndpoint as ApiCdnEndpoint } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type CdnTtl = 60 | 600 | 3600 | 86400 | 604800;

export type CdnEndpointProps = {
  /** The bucket host name to serve, `bucket.domainName`. A change replaces the endpoint. */
  origin: string;
  /**
   * Seconds the edge caches an object.
   *
   * @default 3600
   */
  ttl?: CdnTtl;
  /** Serve on your own host name, for example `"assets.example.com"`. Needs `certificateId`. */
  customDomain?: string;
  /** Certificate for `customDomain`. */
  certificateId?: string;
};

export type CdnEndpoint = Resource<
  "DigitalOcean.Spaces.CdnEndpoint",
  CdnEndpointProps,
  {
    /** CDN endpoint id (UUID). */
    cdnEndpointId: string;
    /** The bucket host name it serves. */
    origin: string;
    /** CDN host name, `<bucket>.<region>.cdn.digitaloceanspaces.com`. */
    endpoint: string;
    /** Seconds the edge caches an object. */
    ttl: number;
    /** Custom host name, when set. */
    customDomain: string | undefined;
    /** ISO 8601 creation time. */
    createdAt: string;
  },
  never,
  Providers
>;

export type CdnEndpointAttributes = CdnEndpoint["Attributes"];

/**
 * The Spaces CDN in front of a bucket: edge caching for the bucket's
 * public objects. `ttl`, `customDomain` and `certificateId` update in
 * place; a new `origin` replaces the endpoint. One endpoint per bucket.
 *
 * ### Serving a Bucket Through the CDN
 * **Example:** Cache public assets for a day
 * ```typescript
 * const assets = yield* DigitalOcean.Spaces.Bucket("assets", {
 *   region: "nyc3",
 *   acl: "public-read",
 * });
 * const cdn = yield* DigitalOcean.Spaces.CdnEndpoint("assets-cdn", {
 *   origin: assets.domainName,
 *   ttl: 86400,
 * });
 * // https://${cdn.endpoint}/logo.png serves assets/logo.png from the edge.
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/CDN-Endpoints
 *
 * @resource
 * @product Spaces
 * @category Storage
 */
export const CdnEndpoint = Resource<CdnEndpoint>("DigitalOcean.Spaces.CdnEndpoint");

const PAGE_SIZE = 200;

const toAttrs = (cdn: ApiCdnEndpoint): CdnEndpointAttributes => ({
  cdnEndpointId: cdn.id,
  origin: cdn.origin,
  endpoint: cdn.endpoint,
  ttl: cdn.ttl,
  customDomain: cdn.custom_domain || undefined,
  createdAt: cdn.created_at,
});

const observeById = (cdnEndpointId: string) =>
  noneIfNotFound(DO.getCdnEndpoint({ cdn_id: cdnEndpointId }).pipe(Effect.map((r) => r.endpoint)));

// One endpoint per origin, so the origin identifies it.
const observeByOrigin = (origin: string) =>
  DO.listCdnEndpoints.items({ per_page: PAGE_SIZE }).pipe(
    Stream.filter((cdn) => cdn.origin === origin),
    Stream.runHead,
  );

const observe = Effect.fn(function* (origin: string, output: CdnEndpointAttributes | undefined) {
  if (output !== undefined) {
    const byId = yield* observeById(output.cdnEndpointId);
    if (Option.isSome(byId)) return byId;
  }
  return yield* observeByOrigin(origin);
});

export const CdnEndpointProvider = () =>
  Provider.succeed(CdnEndpoint, {
    stables: ["cdnEndpointId", "origin", "endpoint", "createdAt"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ olds, output }) {
      const observed = yield* observe(olds.origin, output);
      return Option.getOrUndefined(Option.map(observed, toAttrs));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (news.origin !== olds.origin) return { action: "replace" } as const;
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const ttl = news.ttl ?? 3600;
      const observed = yield* observe(news.origin, output);
      const cdn = yield* Option.match(observed, {
        onNone: () =>
          DO.createCdnEndpoint({
            origin: news.origin,
            ttl,
            custom_domain: news.customDomain,
            certificate_id: news.certificateId,
          }).pipe(Effect.map((r) => r.endpoint)),
        onSome: Effect.succeed,
      });
      const inSync =
        cdn.ttl === ttl &&
        (cdn.custom_domain || undefined) === news.customDomain &&
        (cdn.certificate_id || undefined) === news.certificateId;
      if (inSync) return toAttrs(cdn);
      const updated = yield* DO.updateCdnEndpoints({
        cdn_id: cdn.id,
        ttl,
        custom_domain: news.customDomain ?? "",
        certificate_id: news.certificateId ?? "",
      });
      return toAttrs(updated.endpoint);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteCdnEndpoint({ cdn_id: output.cdnEndpointId }));
    }),
  });
