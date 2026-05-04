import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

export type TunnelProps = {
  /**
   * Name for the tunnel. If omitted, a unique name will be generated.
   *
   * Tunnel names are immutable -- changing the name triggers replacement.
   *
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Secret used by the tunnel connector. If omitted, Cloudflare generates one.
   * Must be at least 32 bytes encoded as base64.
   */
  tunnelSecret?: Redacted.Redacted<string>;
  /**
   * Where the tunnel configuration lives.
   * - `"cloudflare"` - managed remotely via the API (default)
   * - `"local"` - managed via a YAML file on the origin
   *
   * @default "cloudflare"
   */
  configSrc?: "cloudflare" | "local";
  /**
   * Ingress rules describing how requests are routed. Must end with a
   * catch-all rule (e.g. `{ service: "http_status:404" }`). Only honored when
   * `configSrc` is `"cloudflare"`.
   */
  ingress?: Tunnel.IngressRule[];
  /**
   * Origin request configuration applied to all rules. Only honored when
   * `configSrc` is `"cloudflare"`.
   */
  originRequest?: Tunnel.OriginRequestConfig;
  /**
   * Whether to adopt an existing tunnel with the same name when create fails.
   *
   * @default false
   */
  adopt?: boolean;
};

export declare namespace Tunnel {
  /**
   * Ingress rule describing how a hostname or path is routed.
   */
  export interface IngressRule {
    hostname?: string;
    service: string;
    path?: string;
    originRequest?: OriginRequestConfig;
  }
  /**
   * Origin request configuration applied per-rule or globally.
   */
  export interface OriginRequestConfig {
    connectTimeout?: number;
    tlsTimeout?: number;
    tcpKeepAlive?: number;
    noHappyEyeballs?: boolean;
    keepAliveConnections?: number;
    keepAliveTimeout?: number;
    http2Origin?: boolean;
    httpHostHeader?: string;
    caPool?: string;
    noTLSVerify?: boolean;
    disableChunkedEncoding?: boolean;
    proxyType?: string;
    matchSNItoHost?: boolean;
    originServerName?: string;
  }
}

export type Tunnel = Resource<
  "Cloudflare.Tunnel",
  TunnelProps,
  {
    tunnelId: string;
    tunnelName: string;
    accountTag: string | undefined;
    accountId: string;
    createdAt: string | undefined;
    deletedAt: string | undefined;
    configSrc: "cloudflare" | "local";
    token: Redacted.Redacted<string>;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Tunnel that establishes a secure connection from your origin to
 * Cloudflare's edge.
 *
 * @section Creating a Tunnel
 * @example Basic tunnel
 * ```typescript
 * const tunnel = yield* Cloudflare.Tunnel("MyTunnel");
 * // Run the connector with: cloudflared tunnel run --token <Redacted.value(tunnel.token)>
 * ```
 *
 * @example Tunnel with ingress rules
 * ```typescript
 * const tunnel = yield* Cloudflare.Tunnel("Web", {
 *   ingress: [
 *     { hostname: "app.example.com", service: "http://localhost:3000" },
 *     { service: "http_status:404" },
 *   ],
 * });
 * ```
 */
export const Tunnel = Resource<Tunnel>("Cloudflare.Tunnel");

export const TunnelProvider = () =>
  Provider.effect(
    Tunnel,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const createTunnel = yield* zeroTrust.createTunnelCloudflared;
      const getTunnel = yield* zeroTrust.getTunnelCloudflared;
      const deleteTunnel = yield* zeroTrust.deleteTunnelCloudflared;
      const putConfiguration =
        yield* zeroTrust.putTunnelCloudflaredConfiguration;
      const getToken = yield* zeroTrust.getTunnelCloudflaredToken;
      const listTunnels = zeroTrust.listTunnels;

      const createTunnelName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          if (name) return name;
          return yield* createPhysicalName({ id });
        });

      const writeConfiguration = (
        tunnelId: string,
        ingress: Tunnel.IngressRule[] | undefined,
        originRequest: Tunnel.OriginRequestConfig | undefined,
      ) =>
        Effect.gen(function* () {
          if (!ingress && !originRequest) return;
          yield* putConfiguration({
            accountId,
            tunnelId,
            config: { ingress, originRequest },
          });
        });

      const findTunnelByName = (name: string) =>
        listTunnels
          .items({
            accountId,
            name,
            isDeleted: false,
            tunTypes: ["cfd_tunnel"],
          })
          .pipe(
            Stream.filter((t) => t.name === name && !t.deletedAt),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
          );

      return {
        stables: ["tunnelId", "accountTag", "accountId"],
        diff: Effect.fn(function* ({ id, olds = {}, news, output }) {
          if (!isResolved(news)) return undefined;
          if ((output?.accountId ?? accountId) !== accountId) {
            return { action: "replace" } as const;
          }
          const name = yield* createTunnelName(id, news.name);
          const oldName = output?.tunnelName
            ? output.tunnelName
            : yield* createTunnelName(id, olds.name);
          if (name !== oldName) {
            return { action: "replace" } as const;
          }
          const oldSecret = olds.tunnelSecret
            ? Redacted.value(olds.tunnelSecret)
            : undefined;
          const newSecret = news.tunnelSecret
            ? Redacted.value(news.tunnelSecret)
            : undefined;
          if (oldSecret !== newSecret) {
            return { action: "replace" } as const;
          }
          if (
            (olds.configSrc ?? "cloudflare") !==
            (news.configSrc ?? "cloudflare")
          ) {
            return { action: "replace" } as const;
          }
        }),
        create: Effect.fn(function* ({ id, news = {} }) {
          const name = yield* createTunnelName(id, news.name);
          const configSrc = news.configSrc ?? "cloudflare";
          const tunnelSecret = news.tunnelSecret
            ? Redacted.value(news.tunnelSecret)
            : undefined;

          const created = yield* createTunnel({
            accountId,
            name,
            configSrc,
            tunnelSecret,
          }).pipe(
            Effect.catch((err) =>
              Effect.gen(function* () {
                if (!news.adopt) return yield* Effect.fail(err);
                const existing = yield* findTunnelByName(name);
                if (!existing || !existing.id) {
                  return yield* Effect.fail(err);
                }
                return existing;
              }),
            ),
          );

          if (configSrc !== "local") {
            yield* writeConfiguration(
              created.id!,
              news.ingress,
              news.originRequest,
            );
          }

          const token = yield* getToken({
            accountId,
            tunnelId: created.id!,
          });

          return {
            tunnelId: created.id!,
            tunnelName: created.name ?? name,
            accountTag: created.accountTag ?? undefined,
            accountId,
            createdAt: created.createdAt ?? undefined,
            deletedAt: created.deletedAt ?? undefined,
            configSrc,
            token: Redacted.make(token),
          };
        }),
        update: Effect.fn(function* ({ news = {}, output }) {
          const configSrc = news.configSrc ?? output.configSrc;
          if (configSrc !== "local") {
            yield* writeConfiguration(
              output.tunnelId,
              news.ingress,
              news.originRequest,
            );
          }
          return {
            ...output,
            configSrc,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteTunnel({
            accountId: output.accountId,
            tunnelId: output.tunnelId,
          }).pipe(Effect.catch(() => Effect.void));
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          if (output?.tunnelId) {
            return yield* getTunnel({
              accountId: output.accountId,
              tunnelId: output.tunnelId,
            }).pipe(
              Effect.flatMap((t) =>
                getToken({
                  accountId: output.accountId,
                  tunnelId: output.tunnelId,
                }).pipe(
                  Effect.map((token) => ({
                    tunnelId: t.id ?? output.tunnelId,
                    tunnelName: t.name ?? output.tunnelName,
                    accountTag: t.accountTag ?? output.accountTag,
                    accountId: output.accountId,
                    createdAt: t.createdAt ?? output.createdAt,
                    deletedAt: t.deletedAt ?? output.deletedAt,
                    configSrc: ((
                      t as { configSrc?: "cloudflare" | "local" | null }
                    ).configSrc ??
                      output.configSrc ??
                      "cloudflare") as "cloudflare" | "local",
                    token: Redacted.make(token),
                  })),
                ),
              ),
              Effect.catch(() => Effect.succeed(undefined)),
            );
          }
          const name = yield* createTunnelName(id, olds?.name);
          const existing = yield* findTunnelByName(name);
          if (!existing || !existing.id) return undefined;
          const token = yield* getToken({
            accountId,
            tunnelId: existing.id,
          });
          return {
            tunnelId: existing.id,
            tunnelName: existing.name ?? name,
            accountTag: existing.accountTag ?? undefined,
            accountId,
            createdAt: existing.createdAt ?? undefined,
            deletedAt: existing.deletedAt ?? undefined,
            configSrc: ((
              existing as { configSrc?: "cloudflare" | "local" | null }
            ).configSrc ?? "cloudflare") as "cloudflare" | "local",
            token: Redacted.make(token),
          };
        }),
      };
    }),
  );
