import * as environment from "@distilled.cloud/modal/environment";
import * as webhook from "@distilled.cloud/modal/webhook";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { objectName } from "./internal.ts";
import { declarable } from "./internal/Declared.ts";
import type { Providers } from "./Providers.ts";

export class WebhookTokenUnexpectedResponse extends Data.TaggedError(
  "Modal.WebhookTokenUnexpectedResponse",
)<{
  readonly message: string;
}> {}

export interface WebhookTokenProps {
  /**
   * Display name of the token. If omitted, one is generated from the stack,
   * stage and logical ID. Changing it renames the token in place.
   */
  name?: string;
  /**
   * Limit the token to the environments in {@link environments}. Changing it
   * replaces the token (and its secret).
   * @default false
   */
  scoped?: boolean;
  /**
   * Environments a scoped token works in: environment IDs, or yielded
   * `Modal.Environment`s. Ignored unless {@link scoped} is set.
   */
  environments?: Array<string | { readonly environmentId: string }>;
}

export interface WebhookTokenAttributes {
  /** Token ID (`wk-…`), sent as the `Modal-Key` header. */
  tokenId: string;
  /** Token secret (`ws-…`), sent as the `Modal-Secret` header. */
  tokenSecret: Redacted.Redacted<string>;
  /** Display name. */
  name: string;
  /** Whether the token is limited to {@link WebhookTokenProps.environments}. */
  scoped: boolean;
  /** Environment IDs a scoped token works in. */
  environments: string[];
}

/**
 * A Modal proxy auth token: the `Modal-Key` / `Modal-Secret` header pair
 * that web endpoints and sandbox tunnels created with proxy authentication
 * require. A scoped token works only in the environments it lists.
 *
 * Modal shows a token's secret once, at creation, so a token deleted outside
 * Alchemy is recreated with a new secret on the next deploy. Tokens have no
 * unique names, so they can't be adopted and aren't listed for
 * `alchemy nuke`.
 *
 * ### Creating a token
 * **Example:** A workspace-wide token
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Caller = Modal.WebhookToken("Caller", {});
 * ```
 *
 * **Example:** A token scoped to one environment
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Agents = Modal.Environment("Agents", {});
 * export const AgentsCaller = Modal.WebhookToken("AgentsCaller", {
 *   scoped: true,
 *   environments: [Agents],
 * });
 * ```
 *
 * ### Calling a protected endpoint
 * **Example:** Send the header pair
 * ```typescript
 * const token = yield* AgentsCaller;
 * const response = yield* HttpClient.get(url, {
 *   headers: {
 *     "Modal-Key": token.tokenId,
 *     "Modal-Secret": Redacted.value(token.tokenSecret),
 *   },
 * });
 * ```
 *
 * @resource
 * @product WebhookToken
 */
export const WebhookToken = declarable<WebhookToken>()(
  Resource<WebhookToken>("Modal.WebhookToken"),
);

export type WebhookToken = Resource<
  "Modal.WebhookToken",
  WebhookTokenProps,
  WebhookTokenAttributes,
  never,
  Providers
>;

export const WebhookTokenProvider = () =>
  Provider.effect(
    WebhookToken,
    Effect.gen(function* () {
      const observe = Effect.fn(function* (tokenId: string) {
        const { tokens } = yield* webhook.listWebhookToken({});
        return (tokens ?? []).find((token) => token.tokenId === tokenId);
      });

      return {
        stables: ["tokenId", "tokenSecret", "scoped"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if ((news.scoped ?? false) !== (olds?.scoped ?? false)) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output }) {
          if (output === undefined) return undefined;
          const found = yield* observe(output.tokenId);
          if (!found) return undefined;
          return { ...output, name: found.name ?? output.name, scoped: found.scoped ?? false };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* objectName(id, news.name);
          const scoped = news.scoped ?? false;

          // Observe: only a token we created (its secret is in state) can be kept.
          const found = output !== undefined ? yield* observe(output.tokenId) : undefined;
          let current: WebhookTokenAttributes;
          if (found && output) {
            current = { ...output, name: found.name ?? output.name };
          } else {
            // A token under our generated name that state doesn't hold is
            // left from a create that failed before state was saved; its
            // secret is lost, so replace it.
            if (news.name === undefined) {
              const { tokens } = yield* webhook.listWebhookToken({});
              for (const stale of (tokens ?? []).filter((t) => t.name === name)) {
                if (!stale.tokenId) continue;
                yield* webhook
                  .deleteWebhookToken({ tokenId: stale.tokenId })
                  .pipe(Effect.catchTag("WebhookTokenNotFound", () => Effect.void));
              }
            }
            // Ensure
            yield* session.note(`Creating webhook token ${name}...`);
            const created = yield* webhook.createWebhookToken({ name, scoped });
            if (!created.tokenId || created.tokenSecret === undefined) {
              return yield* new WebhookTokenUnexpectedResponse({
                message: `Modal returned no token for ${name}`,
              });
            }
            current = {
              tokenId: created.tokenId,
              tokenSecret: Redacted.isRedacted(created.tokenSecret)
                ? created.tokenSecret
                : Redacted.make(created.tokenSecret),
              name,
              scoped,
              environments: [],
            };
          }

          // Sync the name.
          if (current.name !== name) {
            yield* webhook.updateWebhookToken({ tokenId: current.tokenId, name });
            current = { ...current, name };
          }

          // Sync environments against the observed set.
          if (scoped) {
            // Modal doesn't serve `WebhookTokenEnvironmentList`, so read the
            // token's environments from each environment's token list.
            const { items } = yield* environment.listEnvironment({});
            const observed = new Set<string>();
            for (const env of items ?? []) {
              if (!env.environmentId || !env.name) continue;
              // An environment deleted since the list holds no tokens.
              const { tokens } = yield* webhook
                .webhookTokenListForEnvironment({ environmentName: env.name })
                .pipe(Effect.catchTag("EnvironmentNotFound", () => Effect.succeed({ tokens: [] })));
              if ((tokens ?? []).some((token) => token.tokenId === current.tokenId)) {
                observed.add(env.environmentId);
              }
            }
            const desired = new Set(
              (news.environments ?? []).flatMap((env) =>
                typeof env === "string"
                  ? [env]
                  : typeof env === "object" && env !== null && "environmentId" in env
                    ? [env.environmentId]
                    : [],
              ),
            );
            for (const environmentId of desired) {
              if (!observed.has(environmentId)) {
                yield* webhook.addWebhookTokenEnvironment({
                  tokenId: current.tokenId,
                  environmentId,
                });
              }
            }
            for (const environmentId of observed) {
              if (!desired.has(environmentId)) {
                yield* webhook.removeWebhookTokenEnvironment({
                  tokenId: current.tokenId,
                  environmentId,
                });
              }
            }
            current = { ...current, environments: [...desired] };
          }
          return current;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* webhook
            .deleteWebhookToken({ tokenId: output.tokenId })
            .pipe(Effect.catchTag("WebhookTokenNotFound", () => Effect.void));
        }),
      };
    }),
  );
