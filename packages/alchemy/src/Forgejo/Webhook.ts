import { Services } from "@distilled.cloud/forgejo";
import type { Hook as ApiHook } from "@distilled.cloud/forgejo/repository";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import { isResolved } from "../Diff.ts";
import { discovered, requireOwnership } from "./Ownership.ts";
import * as Redacted from "effect/Redacted";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { listAccessibleRepositories } from "./Lists.ts";
import { paginate } from "./Pagination.ts";
import { replaceWhenChanged } from "./Replacement.ts";
import { matchesDesired } from "./Settings.ts";
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
   * Forgejo 16.0.3 cannot edit signing secrets. Changing or removing this
   * property replaces the hook delete-first, with a delivery gap until the
   * successor is created. Identical hooks cannot be recovered unambiguously.
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
   * Omission leaves the existing header unmanaged. Set an empty string to clear.
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

/** Forgejo exposes no ownership marker to disambiguate identical hooks. */
export class AmbiguousWebhook extends Data.TaggedError("AmbiguousWebhook")<{
  readonly url: string;
}> {}

/** The existing signing secret is write-only and cannot be verified on adoption. */
export class UnverifiableWebhookSecret extends Data.TaggedError(
  "UnverifiableWebhookSecret",
)<{
  readonly message: string;
}> {}

/** Events Forgejo delivers when a webhook declares none. */
const DEFAULT_EVENTS = ["push"] as const;

const target = (props: Pick<WebhookProps, "owner" | "repository">) => ({
  owner: props.owner,
  repo: props.repository,
});

const urlOf = (hook: ApiHook): string => hook.config?.url ?? hook.url;

const attributesOf = (
  props: Pick<WebhookProps, "owner" | "repository">,
  hook: ApiHook,
): WebhookAttributes => ({
  webhookId: hook.id,
  owner: props.owner,
  repository: props.repository,
  url: urlOf(hook),
  updatedAt: hook.updated_at,
});

/**
 * Whether a live hook delivers exactly the declared events, in any order.
 */
const sameEvents = (
  hook: ApiHook,
  events: readonly string[] | undefined,
): boolean =>
  matchesDesired(
    { events: hook.events ?? [] },
    { events: [...(events ?? DEFAULT_EVENTS)] },
  );

/**
 * Candidate discovery from readable configuration, not ownership evidence.
 * Secrets are write-only, and identical candidates require operator intervention.
 */
const matchesIdentity = (
  hook: ApiHook,
  props: Pick<
    WebhookProps,
    "url" | "events" | "active" | "branchFilter" | "contentType"
  >,
): boolean =>
  urlOf(hook) === props.url &&
  sameEvents(hook, props.events) &&
  hook.active === (props.active ?? true) &&
  (hook.branch_filter ?? "") === (props.branchFilter ?? "") &&
  (hook.config?.content_type ?? "json") === (props.contentType ?? "json");

/**
 * Every hook of a repository, or none when the credential cannot read the
 * repository: account-wide enumeration walks repositories the credential
 * may not be able to inspect, and a single inaccessible one must not abort
 * the whole sweep.
 */
const listHooks = (props: Pick<WebhookProps, "owner" | "repository">) =>
  paginate(Services.repository.repoListHooks, target(props)).pipe(
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed([] as readonly ApiHook[]),
    ),
  );

/**
 * A saved ID never falls back to a matcher. Discovery without state requires
 * explicit adoption, and multiple matches fail even with adoption enabled.
 */
const observe = Effect.fn(function* (
  props: Pick<
    WebhookProps,
    | "owner"
    | "repository"
    | "url"
    | "events"
    | "active"
    | "branchFilter"
    | "contentType"
  >,
  webhookId: number | undefined,
) {
  if (webhookId !== undefined) {
    const byId = yield* Services.repository
      .repoGetHook({ ...target(props), id: webhookId })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    return byId;
  }
  const hooks = yield* listHooks(props);
  const matches = hooks.filter((hook) => matchesIdentity(hook, props));
  if (matches.length > 1)
    return yield* new AmbiguousWebhook({ url: props.url });
  return matches[0];
});

const bodyOf = (props: WebhookProps) => ({
  active: props.active ?? true,
  events: props.events === undefined ? [...DEFAULT_EVENTS] : [...props.events],
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
    diff: Effect.fn(function* (input) {
      if (!isResolved(input.news) && input.olds !== undefined) {
        // An unresolved secret cannot safely be treated as an editable setting.
        return { action: "replace" as const, deleteFirst: true };
      }
      const parent = yield* replaceWhenChanged<WebhookProps>(
        "owner",
        "repository",
      )(input);
      if (parent !== undefined) return parent;
      const { news, olds } = input;
      if (
        isResolved(news) &&
        olds !== undefined &&
        (news.secret === undefined
          ? undefined
          : Redacted.value(news.secret)) !==
          (olds.secret === undefined ? undefined : Redacted.value(olds.secret))
      ) {
        // Forgejo 16 cannot edit secrets. Delete-first avoids rediscovering the predecessor.
        return { action: "replace" as const, deleteFirst: true };
      }
    }),
    list: Effect.fn(function* () {
      const repositories = yield* listAccessibleRepositories();
      const hooks = yield* Effect.forEach(
        repositories,
        (repository) => {
          const props = {
            owner: repository.owner.login,
            repository: repository.name,
          };
          return listHooks(props).pipe(
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
      return observed === undefined
        ? undefined
        : discovered(attributesOf(olds, observed), output !== undefined);
    }),
    reconcile: Effect.fn(function* ({ news, olds, output }) {
      if (
        output !== undefined &&
        olds === undefined &&
        news.secret !== undefined
      ) {
        return yield* new UnverifiableWebhookSecret({
          message:
            "Forgejo cannot read or edit an adopted hook's signing secret. Adopt with secret omitted, then declare the secret in a subsequent deployment to replace the hook.",
        });
      }
      // Unrecorded matches must pass the engine's adoption gate first.
      const observed = yield* observe(news, output?.webhookId);

      if (observed !== undefined)
        yield* requireOwnership(output?.webhookId === observed.id, news.url);
      if (observed === undefined) {
        const conflict = yield* observe(news, undefined);
        if (conflict !== undefined) yield* requireOwnership(false, news.url);
      }
      // Authorization headers are write-only; signing secrets are replaced in diff.
      const hook =
        observed === undefined
          ? yield* Services.repository.repoCreateHook({
              ...target(news),
              type: "forgejo",
              ...bodyOf(news),
            })
          : yield* Services.repository.repoEditHook({
              ...target(news),
              id: observed.id,
              ...bodyOf(news),
              config: {
                url: news.url,
                content_type: news.contentType ?? "json",
              },
            });
      return attributesOf(news, hook);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Address the hook from `output` alone: account-wide teardown has no
      // state row, so it passes the Attributes shape as `olds` too.
      yield* Services.repository
        .repoDeleteHook({ ...target(output), id: output.webhookId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
