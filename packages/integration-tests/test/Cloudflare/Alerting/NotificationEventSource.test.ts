import * as Cloudflare from "@alchemy.run/cloudflare";
import { notificationPath } from "@alchemy.run/cloudflare/Alerting/NotificationEventSource";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import * as GitHub from "@alchemy.run/github";
import { Octokit as AmbientOctokit } from "@alchemy.run/github/Octokit";
import { expect } from "@alchemy.run/test";
import * as alerting from "@distilled.cloud/cloudflare/alerting";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import CheckoutWorker, { ISSUE_TITLE } from "./fixtures/checkout-worker.ts";
import NotificationWorker, { IssuePolicy } from "./fixtures/notification-worker.ts";
import { owner, Repo, repository } from "./fixtures/repo.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
});
const { executeWhenReady, getWhenReady } = Test;

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Out-of-band verification with the provider's credentials.
const Octokit = AmbientOctokit.pipe(Effect.provide(GitHub.providers()));

const Stack = Effect.gen(function* () {
  yield* Repo;
  const policy = yield* IssuePolicy;
  const worker = yield* NotificationWorker;
  yield* Cloudflare.Workers.IssueAutomation("BoomIssues", {
    policyId: policy.policyId,
    service: worker.workerName,
    afterOccurrences: 1,
  });
  return {
    policyId: policy.policyId,
    workerName: worker.workerName,
    url: worker.url.as<string>(),
  };
});

// Open issues created since `since` that match. Worker names are stable across
// runs, so the creation time singles out this run's issues.
const issuesSince = (since: string, match: (title: string) => boolean) =>
  Effect.gen(function* () {
    const octokit = yield* Octokit;
    const { data } = yield* Effect.tryPromise(() =>
      octokit.rest.issues.listForRepo({ owner, repo: repository, state: "open", since }),
    );
    return data.filter(
      (issue) => !issue.pull_request && issue.created_at >= since && match(issue.title),
    );
  });

// The fixture repository is retained across runs: close this run's issues.
const closeIssues = (issues: ReadonlyArray<{ number: number }>) =>
  Effect.gen(function* () {
    const octokit = yield* Octokit;
    yield* Effect.forEach(
      issues,
      (issue) =>
        Effect.tryPromise(() =>
          octokit.rest.issues.update({
            owner,
            repo: repository,
            issue_number: issue.number,
            state: "closed",
          }),
        ),
      { discard: true },
    );
  });

test.provider(
  "consumeNotifications opens a GitHub issue for a Workers issue",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const since = new Date().toISOString();
      const { policyId, workerName, url } = yield* stack.deploy(Stack);
      const base = url.replace(/\/+$/, "");
      const deliveryUrl = `${base}${notificationPath({ LogicalId: "IssuePolicy" })}`;

      // The event source bound a webhook destination at the Worker onto a
      // policy declared without mechanisms. Cloudflare only creates a
      // destination whose test message the Worker acknowledged.
      const policy = yield* alerting.getPolicy({ accountId, policyId });
      const webhookIds = (policy.mechanisms?.webhooks ?? []).map((w) => w.id);
      expect(webhookIds).toHaveLength(1);
      const webhook = yield* alerting.getDestinationWebhook({
        accountId,
        webhookId: webhookIds[0]!,
      });
      expect(webhook.url).toEqual(deliveryUrl);

      // A delivery without the secret is rejected.
      yield* getWhenReady(base);
      const forged = yield* executeWhenReady(
        HttpClientRequest.post(deliveryUrl).pipe(
          HttpClientRequest.setHeader("cf-webhook-auth", "not-the-secret"),
          HttpClientRequest.bodyJsonUnsafe({ alert_type: "workers_observability_real_time_issue" }),
        ),
      );
      expect(forged.status).toBe(401);

      // A 5xx response is a Workers issue occurrence. The automation notifies
      // the policy, Cloudflare delivers to the Worker, and the Worker opens a
      // GitHub issue through the `GitHub.CreateIssue` binding.
      const client = yield* HttpClient.HttpClient;
      yield* Effect.forEach([1, 2, 3], () => client.get(`${base}/boom`), { discard: true });

      const issues = yield* issuesSince(since, (title) => title.includes(workerName)).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (issues) => issues.length > 0,
          times: 18,
        }),
      );
      expect(issues.length).toBeGreaterThan(0);
      // Titled with the summary line, with Cloudflare's report as the body.
      expect(issues[0]!.title).toMatch(/^Real-Time Issue '.*' detected in /);
      expect(issues[0]!.body).toContain(`/workers/services/view/${workerName}/production/issues/`);

      yield* closeIssues(issues);

      yield* stack.destroy();
      yield* alerting.getDestinationWebhook({ accountId, webhookId: webhookIds[0]! }).pipe(
        Effect.flatMap(() => Effect.fail({ _tag: "StillExists" as const })),
        Effect.catchTag("WebhookNotFound", () => Effect.void),
        Effect.retry({
          while: (e) => e._tag === "StillExists",
          schedule: Schedule.spaced("2 seconds"),
          times: 10,
        }),
      );

      // The webhook is gone, so no more deliveries: close any issue that
      // arrived after the first poll.
      yield* closeIssues(yield* issuesSince(since, (title) => title.includes(workerName)));
    }).pipe(logLevel),
  {
    timeout: 180_000,
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:alerting",
      "provider:cloudflare:worker",
      "provider:github",
      "live",
    ],
  },
);

// Error events the Worker logged inside `checkout.charge` for a card decline,
// read back through Workers Observability by their log attributes.
const cardDeclineEvents = (accountId: string, workerName: string) =>
  // Suspended so every poll asks for a fresh timeframe, ending a minute ahead
  // to absorb clock skew between this machine and Cloudflare.
  Effect.suspend(() =>
    workers.queryObservabilityTelemetry({
      accountId,
      queryId: "adhoc-card-declines",
      view: "events",
      timeframe: { from: Date.now() - 15 * 60 * 1000, to: Date.now() + 60 * 1000 },
      limit: 100,
      parameters: {
        filters: [
          { key: "$metadata.service", operation: "eq", type: "string", value: workerName },
          { key: "spanName", operation: "eq", type: "string", value: "checkout.charge" },
          { key: "reason", operation: "eq", type: "string", value: "card_declined" },
        ],
      },
    }),
  ).pipe(Effect.map((response) => response.events?.events ?? []));

test.provider(
  "a custom alert filters on Effect span names and log annotations",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const { url, workerName } = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Repo;
          const worker = yield* CheckoutWorker;
          return { url: worker.url.as<string>(), workerName: worker.workerName };
        }),
      );
      const base = url.replace(/\/+$/, "");
      yield* getWhenReady(base);

      const client = yield* HttpClient.HttpClient;
      yield* Effect.forEach(["ord-1", "ord-2", "ord-3"], (order) =>
        client.get(`${base}/charge?order=${order}`),
      );

      // Each error log carries the span name and its annotations as attributes.
      const events = yield* cardDeclineEvents(accountId, workerName).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (events) => events.length >= 3,
          times: 18,
        }),
      );
      expect(events).toHaveLength(3);
      expect(events.map((event) => event.metadata?.level)).toEqual(["error", "error", "error"]);
      expect(events.map((event) => event.metadata?.message)).toEqual([
        "payment declined",
        "payment declined",
        "payment declined",
      ]);
      expect(
        events.map((event) => (event.source as { orderId?: string } | undefined)?.orderId).sort(),
      ).toEqual(["ord-1", "ord-2", "ord-3"]);

      // The alert Cloudflare accepted queries those attributes.
      const policies = yield* alerting.listPolicies.items({ accountId }).pipe(Stream.runCollect);
      const selectors = Array.from(policies)
        .filter((policy) => policy.alertType === "custom_analytics")
        .flatMap(
          (policy) => (policy.filters as { selectors?: string[] } | undefined)?.selectors ?? [],
        )
        .filter((query) => query.includes(workerName));
      expect(selectors).toHaveLength(1);
      expect(selectors[0]).toContain("attributes['spanName'] = 'checkout.charge'");
      expect(selectors[0]).toContain("attributes['reason'] = 'card_declined'");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    timeout: 180_000,
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:alerting",
      "provider:cloudflare:worker",
      "live",
    ],
  },
);

// Slow: Cloudflare delivers the alert about six minutes after the errors are
// logged, and resolves it a minute or two later.
test.provider.skipIf(!!process.env.FAST)(
  "consumeNotifications opens a GitHub issue when a custom alert fires",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const since = new Date().toISOString();
      const { url } = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Repo;
          const worker = yield* CheckoutWorker;
          return { url: worker.url.as<string>() };
        }),
      );
      const base = url.replace(/\/+$/, "");
      yield* getWhenReady(base);

      // Five card declines: three or more within five minutes fire the alert.
      const client = yield* HttpClient.HttpClient;
      yield* Effect.forEach([1, 2, 3, 4, 5], (n) => client.get(`${base}/charge?order=ord-${n}`), {
        discard: true,
      });

      const issues = yield* issuesSince(since, (title) => title === ISSUE_TITLE).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("15 seconds"),
          until: (issues) => issues.length > 0,
          times: 40,
        }),
      );
      expect(issues.length).toBeGreaterThan(0);
      // The body is Cloudflare's report of the alert firing.
      expect(issues[0]!.body).toContain("Trigger: Threshold");
      expect(issues[0]!.body).toContain("Alert Started:");
      yield* closeIssues(issues);

      // Destroying the alert while it fires leaves its incident open, and
      // Cloudflare then never starts a new one for the same query: wait for
      // the resolution (the alert's second history entry) first.
      const policyId = issues[0]!.body!.match(/notifications\/edit\/([0-9a-f]+)/)?.[1];
      expect(policyId).toBeDefined();
      const history = yield* alerting.listHistories.items({ accountId, since }).pipe(
        // History has the id as a dashed UUID; the dashboard link drops the dashes.
        Stream.filter((entry) => entry.policyId?.replaceAll("-", "") === policyId),
        Stream.runCollect,
        Effect.map((entries) => Array.from(entries).length),
        Effect.repeat({
          schedule: Schedule.spaced("15 seconds"),
          until: (entries) => entries >= 2,
          times: 20,
        }),
      );
      expect(history).toBeGreaterThanOrEqual(2);

      yield* stack.destroy();
      yield* closeIssues(yield* issuesSince(since, (title) => title === ISSUE_TITLE));
    }).pipe(logLevel),
  {
    timeout: 1_200_000,
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:alerting",
      "provider:cloudflare:worker",
      "provider:github",
      "live",
    ],
  },
);
