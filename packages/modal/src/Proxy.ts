import * as proxy from "@distilled.cloud/modal/proxy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
  type EnvironmentInput,
  envNameOf,
  environmentOf,
  isGeneratedName,
  objectName,
} from "./internal.ts";
import { declarable } from "./internal/Declared.ts";
import type { Providers } from "./Providers.ts";

export class ProxyUnexpectedResponse extends Data.TaggedError("Modal.ProxyUnexpectedResponse")<{
  readonly message: string;
}> {}

export interface ProxyProps {
  /**
   * Proxy name, unique per environment. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Changing it replaces the
   * proxy.
   */
  name?: string;
  /**
   * Environment the proxy lives in. Changing it replaces the proxy.
   * @default the workspace's default environment
   */
  environment?: EnvironmentInput;
  /**
   * Region the proxy's IPs come from (e.g. `us-east-1`). Changing it
   * replaces the proxy.
   */
  region?: string;
  /**
   * Number of static egress IPs. Traffic through the proxy leaves from one
   * of them.
   * @default 1
   */
  ips?: number;
}

export interface ProxyAttributes {
  /** Proxy ID (`pr-…`). */
  proxyId: string;
  /** Proxy name. */
  name: string;
  /** Environment name, or `undefined` for the workspace default. */
  environment: string | undefined;
  /** Region of the proxy's IPs. */
  region: string | undefined;
  /** The static egress IPs, for allowlists on the systems a sandbox calls. */
  ips: string[];
}

/**
 * A Modal Proxy: static egress IPs for Sandboxes and Functions. Traffic from
 * a sandbox created with `proxy` leaves from these IPs, so a database or API
 * can allowlist them.
 *
 * Proxies are a Modal Team plan feature. Modal proxies have no tags;
 * ownership is inferred from Alchemy state.
 *
 * ### Creating a Proxy
 * **Example:** One static IP
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Egress = Modal.Proxy("Egress", {});
 * ```
 *
 * **Example:** Two IPs in a region
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Egress = Modal.Proxy("Egress", { region: "us-east-1", ips: 2 });
 * ```
 *
 * ### Routing a Sandbox through it
 * **Example:** Pass the proxy when creating a sandbox
 * ```typescript
 * const sandbox = yield* sandboxes.create({ proxy: egress });
 * ```
 *
 * @resource
 * @product Proxy
 */
export const Proxy = declarable<Proxy>()(Resource<Proxy>("Modal.Proxy"));

export type Proxy = Resource<"Modal.Proxy", ProxyProps, ProxyAttributes, never, Providers>;

const toAttrs = (p: proxy.Proxy, env: string | undefined): ProxyAttributes => ({
  proxyId: p.proxyId ?? "",
  name: p.name ?? "",
  environment: env,
  region: p.region || undefined,
  ips: (p.proxyIps ?? []).flatMap((ip) => (ip.proxyIp ? [ip.proxyIp] : [])),
});

export const ProxyProvider = () =>
  Provider.effect(
    Proxy,
    Effect.gen(function* () {
      const observe = Effect.fn(function* (name: string, env: string | undefined) {
        const found = yield* proxy
          .getProxy({ name, environmentName: environmentOf(env) })
          .pipe(Effect.catchTag("ProxyNotFound", () => Effect.undefined));
        return found?.proxy?.proxyId ? found.proxy : undefined;
      });

      return {
        stables: ["proxyId", "name", "environment", "region"],
        diff: Effect.fn(function* ({ id, news, olds, output }) {
          if (!isResolved(news)) return undefined;
          if (envNameOf(news.environment) !== envNameOf(olds?.environment))
            return { action: "replace" } as const;
          if (news.region !== olds?.region) return { action: "replace" } as const;
          const name = yield* objectName(id, news.name);
          if (output !== undefined && name !== output.name) return { action: "replace" } as const;
          return undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* objectName(id, olds?.name));
          const env = output?.environment ?? envNameOf(olds?.environment);
          const found = yield* observe(name, env);
          if (!found) return undefined;
          const attrs = toAttrs(found, env);
          return output !== undefined || olds?.name === undefined ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* objectName(id, news.name));
          // Observe
          let current = yield* observe(name, envNameOf(news.environment));
          // Ensure
          if (!current) {
            yield* session.note(`Creating proxy ${name}...`);
            const created = yield* proxy
              .createProxy({
                name,
                environmentName: environmentOf(envNameOf(news.environment)),
                region: news.region,
              })
              .pipe(
                Effect.map((response) => response.proxy),
                Effect.catchTag("ProxyAlreadyExists", () =>
                  observe(name, envNameOf(news.environment)),
                ),
              );
            if (!created?.proxyId) {
              return yield* new ProxyUnexpectedResponse({
                message: `Modal returned no proxy for ${name}`,
              });
            }
            current = created;
          }
          // Sync the IP count against the observed IPs.
          const desired = news.ips ?? 1;
          const observed = (current.proxyIps ?? []).flatMap((ip) =>
            ip.proxyIp ? [ip.proxyIp] : [],
          );
          for (let i = observed.length; i < desired; i++) {
            yield* session.note(`Adding an IP to proxy ${name}...`);
            yield* proxy.proxyAddIp({ proxyId: current.proxyId });
          }
          for (const ip of observed.slice(desired)) {
            yield* session.note(`Removing IP ${ip} from proxy ${name}...`);
            yield* proxy
              .proxyRemoveIp({ proxyIp: ip })
              .pipe(Effect.catchTag("ProxyNotFound", () => Effect.void));
          }
          const final = (yield* observe(name, envNameOf(news.environment))) ?? current;
          return toAttrs(final, envNameOf(news.environment));
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* proxy
            .deleteProxy({ proxyId: output.proxyId })
            .pipe(Effect.catchTag("ProxyNotFound", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const { proxies } = yield* proxy.listProxy({});
          return (proxies ?? [])
            .filter((p) => p.proxyId && isGeneratedName(p.name))
            .map((p) => toAttrs(p, p.environmentName || undefined));
        }),
      };
    }),
  );
