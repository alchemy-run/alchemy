import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../Diff.ts";
import type { Input } from "../Input.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  ForgejoCredentials,
  ignoreInaccessible,
  optional,
  paginate,
} from "./Client.ts";
import { listAccessibleRepositories } from "./Lists.ts";
import type * as Forgejo from "./Providers.ts";

/**
 * Properties of a Forgejo repository webhook.
 */
export interface WebhookProps {
  /**
   * Repository owner.
   */
  readonly owner: string;
  /**
   * Repository name.
   */
  readonly repository: string;
  /**
   * Delivery URL.
   */
  readonly url: Input<string>;
  /**
   * Forgejo event names to deliver.
   */
  readonly events?: readonly string[];
  /**
   * Secret used to sign webhook deliveries.
   */
  readonly secret?: Redacted.Redacted<string>;
  /**
   * Payload encoding.
   */
  readonly contentType?: "json" | "form";
  /**
   * Whether deliveries are active.
   */
  readonly active?: boolean;
  /**
   * Optional branch glob filter.
   */
  readonly branchFilter?: string;
  /**
   * Optional Authorization header sent with deliveries.
   */
  readonly authorizationHeader?: Redacted.Redacted<string>;
}

/**
 * Observed attributes of a Forgejo repository webhook.
 */
export interface WebhookAttributes {
  /**
   * Stable numeric hook identifier.
   */
  readonly webhookId: number;
  /**
   * Delivery URL.
   */
  readonly url: string;
  /**
   * Last update timestamp.
   */
  readonly updatedAt: string;
}

/**
 * A Forgejo repository webhook resource.
 */
export interface Webhook extends Resource<
  "Forgejo.Webhook",
  WebhookProps,
  WebhookAttributes,
  never,
  Forgejo.Providers
> {}

/**
 * A webhook on a Forgejo repository.
 *
 * ### Creating a Webhook
 * **Example:** Basic Webhook
 * ```typescript
 * yield* Forgejo.Webhook("deploy", {
 *   owner: "acme",
 *   repository: "api",
 *   url: "https://deploy.example/hooks/forgejo",
 * });
 * ```
 *
 * **Example:** Signed Webhook for Selected Events
 * ```typescript
 * import * as Redacted from "effect/Redacted";
 *
 * yield* Forgejo.Webhook("deploy", {
 *   owner: "acme",
 *   repository: "api",
 *   url: "https://deploy.example/hooks/forgejo",
 *   events: ["push", "pull_request"],
 *   secret: Redacted.make(process.env.WEBHOOK_SECRET!),
 *   branchFilter: "main",
 * });
 * ```
 *
 * @resource
 */
export const Webhook = Resource<Webhook>("Forgejo.Webhook");

interface ApiHook {
  readonly id: number;
  readonly url: string;
  readonly updated_at: string;
  readonly config?: Readonly<Record<string, string>>;
}

const hooksPath = (props: Pick<WebhookProps, "owner" | "repository">) =>
  `/repos/${encodeURIComponent(props.owner)}/${encodeURIComponent(props.repository)}/hooks`;

const attributesOf = (hook: ApiHook): WebhookAttributes => ({
  webhookId: hook.id,
  url: hook.config?.url ?? hook.url,
  updatedAt: hook.updated_at ?? new Date().toISOString(),
});

const bodyOf = (props: WebhookProps) => ({
  type: "forgejo",
  active: props.active ?? true,
  events: props.events ?? ["push"],
  branch_filter: props.branchFilter,
  authorization_header:
    props.authorizationHeader === undefined
      ? undefined
      : Redacted.value(props.authorizationHeader),
  config: {
    url: props.url as string,
    content_type: props.contentType ?? "json",
    ...(props.secret === undefined
      ? {}
      : { secret: Redacted.value(props.secret) }),
  },
});

/**
 * Provider layer implementing the Forgejo webhook lifecycle.
 */
export const WebhookProvider = () =>
  Provider.succeed(Webhook, {
    stables: ["webhookId"],
    diff: ({ news, olds }) => {
      if (!isResolved(news) || olds === undefined) return Effect.void;
      return Effect.succeed(
        news.owner !== olds.owner || news.repository !== olds.repository
          ? { action: "replace" as const }
          : undefined,
      );
    },
    list: Effect.fn(function* () {
      const client = yield* ForgejoCredentials;
      const repositories = yield* listAccessibleRepositories();
      const hooks = yield* Effect.forEach(
        repositories,
        (repository) =>
          // A repository whose hooks the credential cannot read is skipped
          // rather than failing the whole sweep.
          ignoreInaccessible(
            paginate<ApiHook>(
              client,
              hooksPath({
                owner: repository.owner.login,
                repository: repository.name,
              }),
            ),
            [] as readonly ApiHook[],
          ),
        { concurrency: 8 },
      );
      return hooks.flat().map(attributesOf);
    }),
    read: Effect.fn(function* ({ olds, output }) {
      if (output === undefined) return undefined;
      const client = yield* ForgejoCredentials;
      const observed = yield* optional(
        client.request<ApiHook>(
          "GET",
          `${hooksPath(olds)}/${output.webhookId}`,
        ),
      );
      return observed === undefined ? undefined : attributesOf(observed);
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const client = yield* ForgejoCredentials;
      const path = hooksPath(news);
      const observed =
        output?.webhookId === undefined
          ? undefined
          : yield* optional(
              client.request<ApiHook>("GET", `${path}/${output.webhookId}`),
            );

      const hook = yield* client.request<ApiHook>(
        observed === undefined ? "POST" : "PATCH",
        observed === undefined ? path : `${path}/${observed.id}`,
        { body: bodyOf(news) },
      );
      return attributesOf(hook);
    }),
    delete: Effect.fn(function* ({ olds, output }) {
      const client = yield* ForgejoCredentials;
      yield* optional(
        client.request<void>(
          "DELETE",
          `${hooksPath(olds)}/${output.webhookId}`,
        ),
      );
    }),
  });
