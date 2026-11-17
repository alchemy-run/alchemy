import * as boat from "@distilled.cloud/boat-dev/boat";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { sameOrg, stackOrg } from "./internal/Org.ts";
import type { Providers } from "./Providers.ts";

export interface AiProxyProps {
  /**
   * Whether the account's AI credentials proxy is on. While it is on, Boat
   * bills the account $1 a day, and $1 per 1,000 proxied requests to the
   * wallet each sandbox bills.
   * @default true
   */
  enabled?: boolean;
}

export interface AiProxyAttributes {
  /** The account the switch belongs to: you, or an organization. */
  accountId: string;
  /**
   * The organization whose switch this is, as the stack's `org` named it;
   * `undefined` for your own.
   */
  org: string | undefined;
  /** Whether the proxy is on. */
  enabled: boolean;
  /** Where sandboxes send proxied requests. */
  proxyUrl: string;
  /**
   * What the switch was before Alchemy first changed it. Destroying the
   * resource puts it back.
   */
  initialEnabled: boolean;
}

export interface AiProxy extends Resource<
  "Boat.AiProxy",
  AiProxyProps,
  AiProxyAttributes,
  never,
  Providers
> {}

/**
 * The AI credentials proxy switch of a Boat account.
 *
 * With the proxy on, a sandbox gets placeholders in place of the keys of
 * its credential profile, and the proxy's URL in place of each base URL.
 * Boat swaps in the real key as a request passes through, so the key never
 * enters the sandbox, and a copied placeholder stops working when the
 * sandbox stops.
 *
 * :::caution
 * The proxy is billed: $1 for each day it is on, and $1 per 1,000 proxied
 * requests. It is one switch for a whole account, so turning it on changes
 * every sandbox that uses one of the account's credential profiles, at its
 * next start.
 * :::
 *
 * The switch is yours, or an organization's. With an `org` on the stack
 * (`Boat.providers({ org })`, or the profile's) it is the organization's,
 * which only an owner can change. That is the same account that owns the
 * stack's `Boat.CredentialProfile`s.
 *
 * The switch always exists, so nothing is created or deleted. Destroying
 * the resource puts the switch back the way it was found.
 *
 * ### Turning the proxy on
 * **Example:** Proxy the credentials of sandboxes you hand to users
 * ```typescript
 * export const MyProfile = Boat.CredentialProfile("MyProfile", {
 *   anthropic: Config.Redacted("ANTHROPIC_API_KEY"),
 * });
 *
 * export const Proxy = Boat.AiProxy("Proxy", { enabled: true });
 *
 * export const Tenants = Boat.Environment("Tenants", {
 *   safeForThirdParties: true,
 *   credentialProfile: MyProfile,
 *   proxyAiCredentials: Proxy,
 * });
 * ```
 *
 * `proxyAiCredentials` takes the proxy itself, so the environment is updated
 * after the switch, and proxies only while it is on. Boat rejects
 * `proxyAiCredentials: true` while the proxy is off.
 *
 * ### Turning the proxy off
 * **Example:** Keep it off
 * ```typescript
 * export const Proxy = Boat.AiProxy("Proxy", { enabled: false });
 * ```
 *
 * @resource
 * @product AI Proxy
 */
export const AiProxy = Resource<AiProxy>("Boat.AiProxy");

/**
 * The account a call addresses. Without an `org`, Boat answers for the
 * active wallet, which may be an organization's, so your own switch is
 * named explicitly.
 */
const account = (org: string | undefined) => ({ org: org ?? "personal" });

export const AiProxyProvider = () =>
  Provider.effect(
    AiProxy,
    Effect.gen(function* () {
      return {
        nuke: { singleton: true },
        stables: ["accountId", "org", "initialEnabled"],
        // Each account has its own switch.
        diff: Effect.fn(function* ({ output }) {
          if (output !== undefined && !sameOrg(output.org, yield* stackOrg)) {
            return { action: "replace" } as const;
          }
        }),
        // The switch always exists and belongs to nobody, so a cold read
        // adopts it; what it shows then is what destroy restores.
        read: Effect.fn(function* ({ output }) {
          const org = output ? output.org : yield* stackOrg;
          const observed = yield* boat.getAiProxy(account(org));
          return {
            accountId: observed.accountId,
            org,
            enabled: observed.enabled,
            proxyUrl: observed.proxyUrl,
            initialEnabled: output !== undefined ? output.initialEnabled : observed.enabled,
          };
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          const org = yield* stackOrg;
          const desired = news.enabled ?? true;

          // Observe.
          const observed = yield* boat.getAiProxy(account(org));

          // Capture what it was before the first change, for destroy.
          const initialEnabled = output !== undefined ? output.initialEnabled : observed.enabled;

          // Sync — only when it differs.
          if (observed.enabled === desired) {
            return {
              accountId: observed.accountId,
              org,
              enabled: observed.enabled,
              proxyUrl: observed.proxyUrl,
              initialEnabled,
            };
          }
          yield* session.note(`Turning the AI credentials proxy ${desired ? "on" : "off"}...`);
          const updated = yield* boat.updateAiProxy({ ...account(org), enabled: desired });
          return {
            accountId: updated.accountId,
            org,
            enabled: updated.enabled,
            proxyUrl: updated.proxyUrl,
            initialEnabled,
          };
        }),
        // Put the switch back the way it was found.
        delete: Effect.fn(function* ({ output }) {
          const observed = yield* boat.getAiProxy(account(output.org));
          if (observed.enabled === output.initialEnabled) return;
          yield* boat.updateAiProxy({ ...account(output.org), enabled: output.initialEnabled });
        }),
      };
    }),
  );
