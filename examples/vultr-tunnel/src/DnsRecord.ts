// ─────────────────────────────────────────────────────────────────────
// TODO(upstream): this file is a workaround, not the right shape.
//
// alchemy/Cloudflare ships providers for Tunnel, Worker, Zone, R2, …
// but no DNS Record resource — the moment you go off the all-Workers
// path (a Cloudflare Tunnel, an external origin, a static A record)
// you need one. This shim covers the bare minimum for this example
// (proxied CNAME, hand-rolled HTTP, custom `CfApi` Context.Service).
//
// A proper `Cloudflare.Dns.Record` should:
//   - Live at `packages/alchemy/src/Cloudflare/Dns/Record.ts`
//   - Reuse `Cloudflare.Credentials.fromAuthProvider()` + the existing
//     `@distilled.cloud/cloudflare` SDK's `createRecord` / `getRecord`
//     / `updateRecord` / `deleteRecord` (already there, all four verbs).
//   - Support A / AAAA / CNAME / TXT / MX / SRV / CAA via a
//     discriminated `type` field, not CNAME-only.
//   - Accept either `zoneId: string` or `zoneName: string` and cache
//     the resolved zone id in attrs.
//   - Adopt by `(zoneId, name, type)` (uniquely identifies a record
//     on CF) instead of always-creating on state loss.
//
// Tracked separately so this PR doesn't tangle with that conversation.
// ─────────────────────────────────────────────────────────────────────
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { HttpMethod } from "effect/unstable/http/HttpMethod";

import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";

const DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4";

/**
 * Minimal Cloudflare API credentials service used by the local DnsRecord
 * resource. Reads `CLOUDFLARE_API_TOKEN` from the environment.
 */
export interface CfCreds {
  readonly apiToken: Redacted.Redacted<string>;
  readonly apiBaseUrl: string;
}

export class CfApi extends Context.Service<CfApi, CfCreds>()(
  "vultr-demo/CfApi",
) {}

export const CfApiFromEnv = Layer.effect(
  CfApi,
  Effect.gen(function* () {
    const apiToken = yield* Config.redacted("CLOUDFLARE_API_TOKEN");
    const apiBaseUrl = yield* Config.string("CLOUDFLARE_API_BASE_URL").pipe(
      Config.withDefault(DEFAULT_BASE_URL),
    );
    return { apiToken, apiBaseUrl };
  }),
);

class CfApiError extends Data.TaggedError("CfApiError")<{
  status: number;
  method: string;
  path: string;
  message: string;
  body?: unknown;
}> {}

class CfRecordNotFound extends Data.TaggedError("CfRecordNotFound")<{
  recordId: string;
}> {}

class CfZoneNotFound extends Data.TaggedError("CfZoneNotFound")<{
  name: string;
}> {}

const cfRequest = <A>(
  method: HttpMethod,
  path: string,
  body?: unknown,
): Effect.Effect<A, CfApiError, CfApi | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const creds = yield* CfApi;
    const client = yield* HttpClient.HttpClient;
    const url = `${creds.apiBaseUrl}${path}`;
    let req = HttpClientRequest.make(method)(url).pipe(
      HttpClientRequest.setHeader(
        "Authorization",
        `Bearer ${Redacted.value(creds.apiToken)}`,
      ),
      HttpClientRequest.setHeader("Accept", "application/json"),
    );
    if (body !== undefined) {
      req = yield* HttpClientRequest.bodyJson(body)(req).pipe(
        Effect.mapError(
          (e) =>
            new CfApiError({
              status: 0,
              method,
              path,
              message: `serialize: ${String(e)}`,
            }),
        ),
      );
    }
    const response = yield* client.execute(req).pipe(
      Effect.scoped,
      Effect.mapError(
        (e) =>
          new CfApiError({
            status: 0,
            method,
            path,
            message: `network: ${String(e)}`,
          }),
      ),
    );
    const text = yield* response.text.pipe(
      Effect.mapError(
        (e) =>
          new CfApiError({
            status: response.status,
            method,
            path,
            message: `read body: ${String(e)}`,
          }),
      ),
    );
    const parsed = text.length > 0 ? JSON.parse(text) : undefined;
    if (response.status >= 400 || (parsed && parsed.success === false)) {
      const message =
        (parsed?.errors?.[0]?.message as string | undefined) ??
        `HTTP ${response.status}`;
      return yield* new CfApiError({
        status: response.status,
        method,
        path,
        message,
        body: parsed,
      });
    }
    return parsed as A;
  });

interface ZoneListResponse {
  result: { id: string; name: string }[];
}

interface DnsRecordResponse {
  result: {
    id: string;
    name: string;
    type: string;
    content: string;
    proxied: boolean;
    ttl: number;
    zone_id: string;
  };
}

const lookupZoneId = (zoneName: string) =>
  Effect.gen(function* () {
    const res = yield* cfRequest<ZoneListResponse>(
      "GET",
      `/zones?name=${encodeURIComponent(zoneName)}`,
    );
    const zone = res.result?.[0];
    if (!zone) return yield* new CfZoneNotFound({ name: zoneName });
    return zone.id;
  });

export type DnsRecordProps = {
  /**
   * Zone name (e.g. `ktarz.com`). The zone must already exist in the
   * configured Cloudflare account.
   */
  zoneName: string;
  /**
   * Fully-qualified record name (e.g. `vultr-demo.ktarz.com`).
   */
  name: string;
  /**
   * For now only CNAME is supported (sufficient for tunnel routing).
   */
  type: "CNAME";
  /**
   * CNAME target (e.g. `<tunnel-id>.cfargotunnel.com`).
   */
  content: string;
  /**
   * Whether the record is proxied through Cloudflare.
   *
   * @default true
   */
  proxied?: boolean;
  /**
   * TTL in seconds. `1` means automatic. Must be at least 60 otherwise.
   *
   * @default 1
   */
  ttl?: number;
  /**
   * Optional comment shown in the Cloudflare dashboard.
   */
  comment?: string;
};

export type DnsRecord = Resource<
  "VultrDemo.Cloudflare.DnsRecord",
  DnsRecordProps,
  {
    recordId: string;
    zoneId: string;
    name: string;
    type: "CNAME";
    content: string;
    proxied: boolean;
    ttl: number;
  }
>;

export const DnsRecord = Resource<DnsRecord>("VultrDemo.Cloudflare.DnsRecord");

export const DnsRecordProvider = () =>
  Provider.effect(
    DnsRecord,
    Effect.succeed({
      stables: ["recordId", "zoneId"],

      diff: Effect.fn(function* ({ news, olds, output }) {
        if (!isResolved(news)) return undefined;
        const o = olds ?? ({} as Partial<DnsRecordProps>);
        if (
          news.zoneName !== (o.zoneName ?? "") ||
          news.name !== (output?.name ?? o.name) ||
          news.type !== (output?.type ?? o.type)
        ) {
          return { action: "replace" } as const;
        }
        return undefined;
      }),

      read: Effect.fn(function* ({ output }) {
        if (!output?.recordId) return undefined;
        return yield* cfRequest<DnsRecordResponse>(
          "GET",
          `/zones/${output.zoneId}/dns_records/${output.recordId}`,
        ).pipe(
          Effect.map(({ result }) => ({
            recordId: result.id,
            zoneId: result.zone_id,
            name: result.name,
            type: result.type as "CNAME",
            content: result.content,
            proxied: result.proxied,
            ttl: result.ttl,
          })),
          Effect.catchTag("CfApiError", (e) =>
            e.status === 404 ? Effect.succeed(undefined) : Effect.fail(e),
          ),
        );
      }),

      reconcile: Effect.fn(function* ({ news, output }) {
        const zoneId = output?.zoneId ?? (yield* lookupZoneId(news.zoneName));
        const body = {
          type: news.type,
          name: news.name,
          content: news.content,
          proxied: news.proxied ?? true,
          ttl: news.ttl ?? 1,
          comment: news.comment,
        };
        const result = output?.recordId
          ? yield* cfRequest<DnsRecordResponse>(
              "PUT",
              `/zones/${zoneId}/dns_records/${output.recordId}`,
              body,
            )
          : yield* cfRequest<DnsRecordResponse>(
              "POST",
              `/zones/${zoneId}/dns_records`,
              body,
            );
        return {
          recordId: result.result.id,
          zoneId: result.result.zone_id,
          name: result.result.name,
          type: result.result.type as "CNAME",
          content: result.result.content,
          proxied: result.result.proxied,
          ttl: result.result.ttl,
        };
      }),

      delete: Effect.fn(function* ({ output }) {
        yield* cfRequest<unknown>(
          "DELETE",
          `/zones/${output.zoneId}/dns_records/${output.recordId}`,
        ).pipe(
          Effect.catchTag("CfApiError", (e) =>
            e.status === 404 ? Effect.succeed(undefined) : Effect.fail(e),
          ),
        );
      }),
    }),
  );
