import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../Diff.ts";
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
  readonly url: string;
  /**
   * Forgejo event names to deliver.
   */
  readonly events?: readonly string[];
  /**
   * Secret used to sign webhook deliveries.
   *
   * Forgejo only overwrites the stored secret when the field is present in
   * the request, so removing this prop leaves the previously-set secret in
   * place rather than clearing it. Set it to an empty string to clear.
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
   *
   * Cannot be cleared by removing the prop; see {@link secret}.
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
   * Repository owner. Carried on the attributes so account-wide teardown,
   * which has no state row to read props from, can still address the hook.
   */
  readonly owner: string;
  /**
   * Repository name.
   */
  readonly repository: string;
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
  readonly updated_at?: string;
  readonly config?: Readonly<Record<string, string>>;
  readonly events?: readonly string[];
}

/** Events Forgejo delivers when a webhook declares none. */
const DEFAULT_EVENTS = ["push"] as const;

const hooksPath = (props: Pick<WebhookProps, "owner" | "repository">) =>
  `/repos/${encodeURIComponent(props.owner)}/${encodeURIComponent(props.repository)}/hooks`;

const attributesOf = (
  props: Pick<WebhookProps, "owner" | "repository">,
  hook: ApiHook,
): WebhookAttributes => ({
  webhookId: hook.id,
  owner: props.owner,
  repository: props.repository,
  url: hook.config?.url ?? hook.url,
  updatedAt: hook.updated_at ?? "",
});

const urlOf = (hook: ApiHook): string => hook.config?.url ?? hook.url;

const sameEvents = (
  hook: ApiHook,
  events: readonly string[] | undefined,
): boolean => {
  const observed = [...(hook.events ?? [])].sort();
  const desired = [...(events ?? DEFAULT_EVENTS)].sort();
  return (
    observed.length === desired.length &&
    observed.every((event, index) => event === desired[index])
  );
};

/**
 * Locate the live hook, by ID when one is already known and otherwise by
 * delivery URL *and* event set within the repository.
 *
 * Forgejo happily accepts several hooks pointing at the same URL, so creating
 * unconditionally would turn a create whose state write failed into a
 * duplicate on every retry. Matching an existing hook adopts it instead.
 *
 * The event set is part of the match because the URL alone is not unique: two
 * `Webhook` resources may legitimately target one URL in one repository with
 * different events (say `push` versus `pull_request`), and matching on URL
 * alone would collapse them onto a single hook, each deploy overwriting the
 * other's configuration.
 */
const observe = Effect.fn(function* (
  props: Pick<WebhookProps, "owner" | "repository" | "url" | "events">,
  webhookId: number | undefined,
) {
  const client = yield* ForgejoCredentials;
  if (webhookId !== undefined) {
    const byId = yield* optional(
      client.request<ApiHook>("GET", `${hooksPath(props)}/${webhookId}`),
    );
    if (byId !== undefined) return byId;
  }
  const hooks = yield* ignoreInaccessible(
    paginate<ApiHook>(client, hooksPath(props)),
    [] as readonly ApiHook[],
  );
  return hooks.find(
    (hook) => urlOf(hook) === props.url && sameEvents(hook, props.events),
  );
});

const bodyOf = (props: WebhookProps) => ({
  active: props.active ?? true,
  events: props.events ?? [...DEFAULT_EVENTS],
  branch_filter: props.branchFilter,
  authorization_header:
    props.authorizationHeader === undefined
      ? undefined
      : Redacted.value(props.authorizationHeader),
  config: {
    url: props.url,
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
    stables: ["webhookId", "owner", "repository"],
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
        (repository) => {
          const props = {
            owner: repository.owner.login,
            repository: repository.name,
          };
          // A repository whose hooks the credential cannot read is skipped
          // rather than failing the whole sweep.
          return ignoreInaccessible(
            paginate<ApiHook>(client, hooksPath(props)),
            [] as readonly ApiHook[],
          ).pipe(
            Effect.map((found) =>
              found.map((hook) => attributesOf(props, hook)),
            ),
          );
        },
        { concurrency: 8 },
      );
      return hooks.flat();
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const observed = yield* observe(olds, output?.webhookId);
      return observed === undefined ? undefined : attributesOf(olds, observed);
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const client = yield* ForgejoCredentials;
      const path = hooksPath(news);
      // Observe: live state decides create-vs-update, so adoption and a
      // re-run after a failed state write both converge onto one hook.
      const observed = yield* observe(news, output?.webhookId);

      // `CreateHookOption` carries `type`; `EditHookOption` does not.
      const hook = yield* client.request<ApiHook>(
        observed === undefined ? "POST" : "PATCH",
        observed === undefined ? path : `${path}/${observed.id}`,
        {
          body:
            observed === undefined
              ? { type: "forgejo", ...bodyOf(news) }
              : bodyOf(news),
        },
      );
      return attributesOf(news, hook);
    }),
    delete: Effect.fn(function* ({ output }) {
      if (output === undefined) return;
      const client = yield* ForgejoCredentials;
      // Address the hook from `output` alone: account-wide teardown has no
      // state row, so it passes the Attributes shape as `olds` too.
      yield* optional(
        client.request<void>(
          "DELETE",
          `${hooksPath(output)}/${output.webhookId}`,
        ),
      );
    }),
  });
