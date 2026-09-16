import type { Octokit as OctokitClient } from "@octokit/rest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as LocalProvider from "../Dev/LocalProvider.ts";
import { Octokit } from "./Octokit.ts";
import type { WebhookEventName } from "./RepositoryEventSource.ts";
import {
  backfillOpenPullRequests,
  isPollableEvent,
  POLLABLE_EVENTS,
  pollRepositoryEvent,
  type PollableEventName,
  type SynthesizedRepositoryEvent,
} from "./RepositoryEventSourcePolling.ts";
import { Webhook } from "./Webhook.ts";

/** How often the emulator polls the GitHub REST API for new activity. */
const POLL_EVERY = "10 seconds";

/** Restart surface: any change re-derives the poll loop. */
export interface Config {
  readonly owner: string;
  readonly repository: string;
  readonly url: string;
  readonly events: ReadonlyArray<string>;
  readonly secret: Redacted.Redacted<string> | undefined;
}

/**
 * The emulator LOOP — polls the REST API, synthesizes webhook-shaped
 * deliveries, and POSTs each one to `config.url` in entity order. A
 * delivery the receiver did not acknowledge (still booting, non-2xx)
 * leaves the cursor in place and retries on the next tick; delivery
 * ids are deterministic, so the receiver's dedupe absorbs any overlap.
 * Exported for the scripted tests; runs forked in the instance scope.
 */
export const emulateWebhook = (
  octokit: OctokitClient,
  config: Config,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const names: PollableEventName[] = config.events.includes("*")
      ? [...POLLABLE_EVENTS]
      : [...new Set(config.events.filter(isPollableEvent))];
    const unsupported = config.events.filter(
      (name) => name !== "*" && !isPollableEvent(name),
    );
    if (unsupported.length > 0) {
      yield* Effect.logWarning(
        `GitHub.Webhook (dev): cannot emulate [${unsupported.join(", ")}] for ${config.owner}/${config.repository} by polling — only [${POLLABLE_EVENTS.join(", ")}] are synthesizable; these events will not be delivered locally`,
      );
    }
    if (names.length === 0) return;

    const props = {
      owner: config.owner,
      repository: config.repository,
      events: config.events as WebhookEventName[],
    };
    const secret =
      config.secret === undefined ? undefined : Redacted.value(config.secret);

    // cursor starts at "now": only NEW activity is delivered. The same
    // eventual-consistency LOOKBACK + dedupe-by-id the polling event
    // source uses (see its module JSDoc).
    const started = yield* Clock.currentTimeMillis;
    const cursor = yield* Ref.make(started);
    const LOOKBACK_MS = 120_000;
    const delivered = new Map<string, number>();

    // Registration-time backfill (see {@link backfillOpenPullRequests}):
    // opened deliveries for every OPEN pull request, queued rather than
    // fire-and-forget — the Worker may still be booting, so each tick
    // drains what the receiver has not yet acknowledged before any new
    // activity (order preserved). `undefined` = not yet fetched.
    const backlog = yield* Ref.make<SynthesizedRepositoryEvent[] | undefined>(
      names.includes("pull_request") ? undefined : [],
    );

    const pollOnce = Effect.gen(function* () {
      let pending = yield* Ref.get(backlog);
      if (pending === undefined) {
        pending = yield* backfillOpenPullRequests(octokit, props);
        yield* Ref.set(backlog, pending);
        if (pending.length > 0) {
          yield* Effect.logInfo(
            `GitHub.Webhook (dev): backfilling ${pending.length} open pull request(s) of ${config.owner}/${config.repository}`,
          );
        }
      }
      while (pending.length > 0) {
        const next = pending[0]!;
        const posted = yield* post(config.url, secret, next.event);
        if (!posted) return; // receiver not serving yet — retry next tick
        delivered.set(next.event.id, next.at);
        pending = pending.slice(1);
        yield* Ref.set(backlog, pending);
      }

      const since = yield* Ref.get(cursor);
      const lookback = Math.max(since - LOOKBACK_MS, started);
      const batches = yield* Effect.forEach(names, (name) =>
        pollRepositoryEvent(octokit, props, name, lookback),
      );
      for (const [id, at] of delivered) {
        if (at < lookback - LOOKBACK_MS) delivered.delete(id);
      }
      const deliveries = batches
        .flat()
        .filter((d) => d.at > lookback && !delivered.has(d.event.id))
        .sort((a, b) => a.at - b.at || (a.event.id < b.event.id ? -1 : 1));
      for (const delivery of deliveries) {
        const posted = yield* post(config.url, secret, delivery.event);
        // the Worker may still be booting: keep the cursor so the
        // delivery (and everything after it, in order) retries
        if (!posted) return;
        delivered.set(delivery.event.id, delivery.at);
        yield* Ref.update(cursor, (prev) => Math.max(prev, delivery.at));
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(
            `GitHub.Webhook (dev) poll of ${config.owner}/${config.repository} failed`,
            error,
          );
          // A RATE-LIMITED poll must not keep hammering: GitHub's
          // secondary limits clear on the order of a minute, and the
          // spaced schedule measures from COMPLETION — holding this
          // tick stretches the loop to ~70s until the window resets.
          if (/rate limit/i.test(String(error))) {
            yield* Effect.logWarning(
              `GitHub.Webhook (dev): rate limited — backing off for 60 seconds`,
            );
            yield* Effect.sleep("60 seconds");
          }
        }),
      ),
    );

    yield* Effect.logInfo(
      `GitHub.Webhook (dev): emulating [${names.join(", ")}] of ${config.owner}/${config.repository} by polling every ${POLL_EVERY} → ${config.url}`,
    );

    yield* pollOnce.pipe(
      Effect.repeat(Schedule.spaced(POLL_EVERY)),
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
          ? Effect.logError(
              `GitHub.Webhook (dev) emulator of ${config.owner}/${config.repository} DIED — no further events will be delivered`,
              exit.cause,
            )
          : Effect.void,
      ),
      Effect.asVoid,
    );
  });

/**
 * The DEV-MODE {@link Webhook}: GitHub refuses delivery URLs that are
 * not publicly reachable (`localhost` → 422), so `alchemy dev` cannot
 * provision a real repository webhook against the local Worker.
 * Instead of the GitHub API, the local variant runs a POLL LOOP in the
 * dev sidecar that synthesizes webhook-shaped deliveries from the REST
 * API ({@link pollRepositoryEvent} — the same synthesis the polling
 * event source uses) and POSTs each one to the resource's `url` as a
 * REAL delivery: `x-github-event` / `x-github-delivery` headers and an
 * `x-hub-signature-256` HMAC when a secret is configured. The local
 * Worker's runtime path — signature verification included — is
 * exercised byte-for-byte as in production; only GitHub's push
 * transport is emulated.
 *
 * Fidelity limits are the polling event source's: only
 * `issues` / `issue_comment` / `pull_request` are synthesizable (other
 * names warn once and are skipped), poll-interval granularity, and a
 * cursor that starts at "now" — only activity newer than the dev
 * session is delivered, EXCEPT open pull requests, which are
 * backfilled once at registration (see `backfillOpenPullRequests`) so
 * a PR opened while dev was down still starts its review. Delivery ids
 * are deterministic (`poll/{owner}/{repo}/…`), so the receiver's
 * ledger dedupe holds across dev restarts. A failed POST (the Worker
 * still booting) leaves the cursor in place — the delivery retries on
 * the next tick.
 */
export const LocalWebhookProvider = () =>
  LocalProvider.make(
    Webhook,
    import.meta.resolve(
      import.meta.url.endsWith(".ts")
        ? "./WebhookLocal.ts"
        : "./WebhookLocal.js",
      import.meta.url,
    ),
    Effect.gen(function* () {
      const octokit = yield* Octokit;

      return {
        resolveConfig: ({ news }: { news: Webhook["Props"] }) =>
          Effect.succeed<Config>({
            owner: news.owner,
            repository: news.repository,
            url: news.url as string,
            events: news.events ?? ["push"],
            secret: news.secret,
          }),

        start: Effect.fn(function* ({ config }: { config: Config }) {
          const started = yield* Clock.currentTimeMillis;
          // the "process": a poll fiber in the instance scope — closed
          // by the runner on restart (config change) or delete
          yield* emulateWebhook(octokit, config).pipe(Effect.forkScoped);
          return {
            // no GitHub hook exists — the id is the emulator's marker
            webhookId: -1,
            url: config.url,
            pingUrl: undefined,
            testUrl: undefined,
            updatedAt: new Date(started).toISOString(),
          } satisfies Webhook["Attributes"];
        }),
      };
    }),
  );

/**
 * POST one synthesized delivery exactly as GitHub would: JSON body,
 * event/delivery headers, HMAC-SHA256 signature when a secret is
 * configured. `false` = not delivered (receiver unreachable or
 * non-2xx) — the caller retries next tick.
 */
const post = (
  url: string,
  secret: string | undefined,
  event: { id: string; name: string; payload: unknown },
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const body = JSON.stringify(event.payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-github-event": event.name,
      "x-github-delivery": event.id,
      "user-agent": "alchemy-dev-webhook-emulator",
    };
    if (secret !== undefined) {
      headers["x-hub-signature-256"] = yield* sign(secret, body);
    }
    const status = yield* Effect.tryPromise(() =>
      fetch(url, { method: "POST", headers, body }).then(
        (response) => response.status,
      ),
    ).pipe(Effect.option);
    if (status._tag === "Some" && status.value >= 200 && status.value < 300) {
      return true;
    }
    yield* Effect.logWarning(
      `GitHub.Webhook (dev): delivery ${event.id} to ${url} ${
        status._tag === "Some" ? `returned ${status.value}` : "failed"
      } — retrying next poll`,
    );
    return false;
  });

/** `sha256=<hex hmac>` — the signature GitHub sends and receivers verify. */
const sign = (secret: string, body: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
    const hex = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return `sha256=${hex}`;
  });
