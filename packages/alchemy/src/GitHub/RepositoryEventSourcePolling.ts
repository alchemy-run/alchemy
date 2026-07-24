/**
 * A LOCAL, polling implementation of {@link RepositoryEventSource} — the
 * same tag the Cloudflare webhook Layer
 * (`Cloudflare.Workers.GitHubRepositoryEventSourceLive`) provides, so a
 * process implementation written against `consumeRepositoryEvents` runs
 * on a laptop unchanged: the environment is chosen entirely at Layer
 * composition.
 *
 * Each `consume` registration forks a scoped poll loop (owned by the
 * Layer's Scope — closing the Scope stops all polling) that polls ONLY
 * the events the registration requested and synthesizes
 * `WebhookEvent`-shaped `{ id, name, payload }` deliveries from the
 * GitHub REST API:
 *
 * - `issues` — issues updated since the cursor → `issues.opened`
 *   (created in the window) and `issues.closed` (closed in the window).
 *   `issues.labeled` is NOT synthesized (label *timing* is not
 *   recoverable from REST — the events API would be needed).
 * - `issue_comment` — comments since the cursor → `issue_comment.created`.
 * - `pull_request` — PRs sorted by update → `pull_request.opened`
 *   (created in the window) and `pull_request.closed` (closed in the
 *   window, `merged: true` when GitHub recorded a merge).
 * - `push` and every other event name — UNSUPPORTED by polling (no
 *   `since`-queryable REST surface): a warning is logged once at
 *   registration and the name is skipped. `"*"` selects exactly the
 *   three supported names above.
 *
 * Fidelity limits (vs the webhook Layer): poll-interval granularity
 * (rapid open→close inside one interval yields both events in one
 * batch; actions between polls that leave no timestamp — e.g. a label
 * added and removed — are invisible), no delivery signatures (there is
 * no wire to verify), and synthesized payloads carry only the fields
 * the wire parser ({@link parseWebhookEvent}) reads — not the full
 * Octokit webhook payload.
 *
 * Delivery ids are DETERMINISTIC —
 * `poll/{owner}/{repo}/{event}.{action}/{number-or-id}/{iso-timestamp}`
 * — derived from the entity, never from poll time, so a ledger's dedupe
 * by delivery id holds across process restarts.
 *
 * Cursor state is in-memory per registration, starting at "now": only
 * activity NEWER than the moment the registration was made is observed
 * (a restart re-observes anything newer than the restart — which is
 * exactly what the deterministic ids + a durable ledger absorb).
 *
 * Requires {@link GitHubCredentials} (the {@link Octokit} client):
 * provide `GitHub.fromEnv()` (reads `GITHUB_ACCESS_TOKEN` or
 * `GITHUB_TOKEN`), `GitHub.fromToken(…)`, or the auth-provider Layer.
 *
 * @example
 * ```typescript
 * const FactoryLocal = GitHubIssuesLive.pipe(
 *   Layer.provide(GitHub.RepositoryEventSourcePolling({ every: "30 seconds" })),
 *   Layer.provide(GitHub.fromEnv()),
 * );
 * ```
 */
import type { Octokit as OctokitClient } from "@octokit/rest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type { GitHubCredentials } from "./Credentials.ts";
import { Octokit } from "./Octokit.ts";
import {
  RepositoryEventSource,
  type RepositoryEventSourceProps,
  type RepositoryEventSourceService,
  type WebhookEvent,
} from "./RepositoryEventSource.ts";

export interface RepositoryEventSourcePollingOptions {
  /**
   * How often each registration polls the GitHub REST API.
   * @default "30 seconds"
   */
  readonly every?: Duration.Input;
}

/** The event names polling can synthesize (see the module JSDoc). */
const SUPPORTED = ["issues", "issue_comment", "pull_request"] as const;
type SupportedEventName = (typeof SUPPORTED)[number];

const isSupported = (name: string): name is SupportedEventName =>
  (SUPPORTED as readonly string[]).includes(name);

/** One synthesized delivery, ordered by the entity timestamp that gated it. */
interface Synthesized {
  readonly at: number;
  readonly event: WebhookEvent;
}

/**
 * Build the polling Layer. See the module JSDoc for semantics and
 * fidelity limits.
 */
export const RepositoryEventSourcePolling = (
  options?: RepositoryEventSourcePollingOptions,
): Layer.Layer<RepositoryEventSource, never, GitHubCredentials> =>
  Layer.effect(
    RepositoryEventSource,
    Effect.gen(function* () {
      const octokit = yield* Octokit;
      // the Layer's Scope owns every registration's poll loop
      const scope = yield* Effect.scope;
      const every = options?.every ?? "30 seconds";

      return ((
        props: RepositoryEventSourceProps,
        process: (event: WebhookEvent) => Effect.Effect<void, never, never>,
      ) =>
        Effect.gen(function* () {
          const requested = props.events ?? ["push"];
          const names: SupportedEventName[] = requested.includes("*")
            ? [...SUPPORTED]
            : [...new Set(requested.filter(isSupported))];
          const unsupported = requested.filter(
            (name) => name !== "*" && !isSupported(name),
          );
          if (unsupported.length > 0) {
            // once per registration — polling has no REST surface for these
            yield* Effect.logWarning(
              `GitHub.RepositoryEventSourcePolling cannot synthesize [${unsupported.join(
                ", ",
              )}] for ${props.owner}/${props.repository} — polling supports only [${SUPPORTED.join(
                ", ",
              )}]; these events will not be delivered (use the webhook Layer for them)`,
            );
          }
          if (names.length === 0) return;

          // cursor starts at "now": only NEW activity is observed
          const cursor = yield* Ref.make(yield* Clock.currentTimeMillis);

          yield* Effect.logInfo(
            `GitHub polling [${names.join(", ")}] of ${props.owner}/${props.repository} every ${String(every)}`,
          );

          const pollOnce = Effect.gen(function* () {
            const since = yield* Ref.get(cursor);
            const batches = yield* Effect.forEach(names, (name) =>
              pollEvent(octokit, props, name, since),
            );
            const deliveries = batches
              .flat()
              .filter((d) => d.at > since)
              .sort(
                (a, b) => a.at - b.at || (a.event.id < b.event.id ? -1 : 1),
              );
            if (deliveries.length > 0) {
              yield* Effect.logInfo(
                `GitHub poll of ${props.owner}/${props.repository}: delivering ${deliveries.length} event(s): ${deliveries
                  .map((d) => d.event.id)
                  .join(", ")}`,
              );
            }
            for (const delivery of deliveries) {
              yield* process(delivery.event);
            }
            if (deliveries.length > 0) {
              const max = deliveries[deliveries.length - 1]!.at;
              yield* Ref.update(cursor, (prev) => Math.max(prev, max));
            }
          }).pipe(
            // a failed poll (network, rate limit) never kills the loop —
            // the next tick retries from the same cursor
            Effect.catch((error) =>
              Effect.logWarning(
                `GitHub.RepositoryEventSourcePolling poll of ${props.owner}/${props.repository} failed`,
                error,
              ),
            ),
          );

          yield* Effect.forkIn(
            pollOnce.pipe(
              Effect.repeat(Schedule.spaced(every)),
              // a dead poll loop must be LOUD: a defect in a delivery
              // handler would otherwise kill polling silently forever
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? Cause.hasInterruptsOnly(exit.cause)
                    ? Effect.logWarning(
                        `GitHub polling loop of ${props.owner}/${props.repository} interrupted — polling stopped`,
                      )
                    : Effect.logError(
                        `GitHub polling loop of ${props.owner}/${props.repository} DIED — no further events will be delivered`,
                        exit.cause,
                      )
                  : Effect.void,
              ),
            ),
            scope,
          );
        })) as RepositoryEventSourceService;
    }),
  );

/**
 * Deterministic delivery id — a pure function of the entity, never of
 * poll time, so ledger dedupe holds across restarts.
 */
const deliveryId = (
  props: { owner: string; repository: string },
  eventAction: string,
  entity: string | number,
  timestamp: string,
): string =>
  `poll/${props.owner}/${props.repository}/${eventAction}/${entity}/${timestamp}`;

const pollEvent = (
  octokit: OctokitClient,
  props: RepositoryEventSourceProps,
  name: SupportedEventName,
  since: number,
): Effect.Effect<Synthesized[], Error> => {
  switch (name) {
    case "issues":
      return pollIssues(octokit, props, since);
    case "issue_comment":
      return pollIssueComments(octokit, props, since);
    case "pull_request":
      return pollPullRequests(octokit, props);
  }
};

/**
 * The synthesized payloads carry exactly the fields the wire parser
 * {@link parseWebhookEvent} reads (action, issue{number,title,body,state},
 * comment{user{login},body}, pull_request{number,title,merged},
 * repository{name,owner{login}}). A full Octokit webhook payload is not
 * reproducible from REST, so this single synthesis site casts across
 * the boundary — same as the webhook runtime, where GitHub's headers
 * are the source of truth.
 */
const synthesize = (
  at: number,
  event: {
    id: string;
    name: SupportedEventName;
    payload: unknown;
  },
): Synthesized => ({ at, event: event as unknown as WebhookEvent });

const repositoryPayload = (props: RepositoryEventSourceProps) => ({
  name: props.repository,
  owner: { login: props.owner },
});

const pollIssues = (
  octokit: OctokitClient,
  props: RepositoryEventSourceProps,
  since: number,
): Effect.Effect<Synthesized[], Error> =>
  Effect.gen(function* () {
    // one page per poll — bounded by design; deep backlogs surface on
    // subsequent ticks as the cursor advances
    const response = yield* Effect.tryPromise({
      try: () =>
        octokit.rest.issues.listForRepo({
          owner: props.owner,
          repo: props.repository,
          state: "all",
          sort: "updated",
          direction: "asc",
          since: new Date(since).toISOString(),
          per_page: 100,
        }),
      catch: (cause) => new Error(`issues.listForRepo failed: ${cause}`),
    });

    const deliveries: Synthesized[] = [];
    for (const issue of response.data) {
      // the `issues` webhook never fires for pull requests; the REST
      // issues list includes them — skip for parity
      if (issue.pull_request !== undefined) continue;
      const base = {
        issue: {
          number: issue.number,
          title: issue.title,
          body: issue.body ?? "",
          state: issue.state,
        },
        repository: repositoryPayload(props),
      };
      const createdAt = Date.parse(issue.created_at);
      if (createdAt > since) {
        deliveries.push(
          synthesize(createdAt, {
            id: deliveryId(
              props,
              "issues.opened",
              issue.number,
              issue.created_at,
            ),
            name: "issues",
            payload: { action: "opened", ...base },
          }),
        );
      }
      if (issue.state === "closed" && issue.closed_at !== null) {
        const closedAt = Date.parse(issue.closed_at);
        if (closedAt > since) {
          deliveries.push(
            synthesize(closedAt, {
              id: deliveryId(
                props,
                "issues.closed",
                issue.number,
                issue.closed_at,
              ),
              name: "issues",
              payload: { action: "closed", ...base },
            }),
          );
        }
      }
      // `issues.labeled` is deliberately not synthesized: REST exposes
      // the current label SET, not when a label was applied.
    }
    return deliveries;
  });

const issueNumberFromUrl = (issueUrl: string): number | undefined => {
  const match = issueUrl.match(/\/issues\/(\d+)$/);
  return match ? Number(match[1]) : undefined;
};

const pollIssueComments = (
  octokit: OctokitClient,
  props: RepositoryEventSourceProps,
  since: number,
): Effect.Effect<Synthesized[], Error> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        octokit.rest.issues.listCommentsForRepo({
          owner: props.owner,
          repo: props.repository,
          sort: "created",
          direction: "asc",
          since: new Date(since).toISOString(),
          per_page: 100,
        }),
      catch: (cause) =>
        new Error(`issues.listCommentsForRepo failed: ${cause}`),
    });

    const deliveries: Synthesized[] = [];
    for (const comment of response.data) {
      const number = issueNumberFromUrl(comment.issue_url);
      if (number === undefined) continue;
      const createdAt = Date.parse(comment.created_at);
      if (createdAt <= since) continue;
      // GitHub's webhook marks PR-thread comments with
      // `issue.pull_request`; REST comments reveal it in `html_url`
      // (`…/pull/33#issuecomment-…`) — synthesize the same marker so
      // routing can tell the two thread kinds apart.
      const isPullRequest = comment.html_url?.includes("/pull/") ?? false;
      deliveries.push(
        synthesize(createdAt, {
          id: deliveryId(
            props,
            "issue_comment.created",
            comment.id,
            comment.created_at,
          ),
          name: "issue_comment",
          payload: {
            action: "created",
            issue: isPullRequest ? { number, pull_request: {} } : { number },
            comment: {
              user: { login: comment.user?.login ?? "unknown" },
              body: comment.body ?? "",
            },
            repository: repositoryPayload(props),
          },
        }),
      );
    }
    return deliveries;
  });

const pollPullRequests = (
  octokit: OctokitClient,
  props: RepositoryEventSourceProps,
): Effect.Effect<Synthesized[], Error> =>
  Effect.gen(function* () {
    // pulls.list has no `since` — most-recently-updated first, one page,
    // filtered client-side against the cursor by the caller
    const response = yield* Effect.tryPromise({
      try: () =>
        octokit.rest.pulls.list({
          owner: props.owner,
          repo: props.repository,
          state: "all",
          sort: "updated",
          direction: "desc",
          per_page: 100,
        }),
      catch: (cause) => new Error(`pulls.list failed: ${cause}`),
    });

    const deliveries: Synthesized[] = [];
    for (const pull of response.data) {
      const base = {
        pull_request: {
          number: pull.number,
          title: pull.title,
          merged: pull.merged_at !== null,
        },
        repository: repositoryPayload(props),
      };
      const createdAt = Date.parse(pull.created_at);
      deliveries.push(
        synthesize(createdAt, {
          id: deliveryId(
            props,
            "pull_request.opened",
            pull.number,
            pull.created_at,
          ),
          name: "pull_request",
          payload: { action: "opened", ...base },
        }),
      );
      if (pull.closed_at !== null) {
        // merges arrive as closed + merged, exactly like the webhook
        const closedAt = Date.parse(pull.merged_at ?? pull.closed_at);
        deliveries.push(
          synthesize(closedAt, {
            id: deliveryId(
              props,
              "pull_request.closed",
              pull.number,
              pull.merged_at ?? pull.closed_at,
            ),
            name: "pull_request",
            payload: { action: "closed", ...base },
          }),
        );
      }
    }
    return deliveries;
  });
