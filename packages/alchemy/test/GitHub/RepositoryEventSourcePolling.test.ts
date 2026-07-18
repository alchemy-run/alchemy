/**
 * Scripted tests for `GitHub.RepositoryEventSourcePolling` — the local,
 * polling implementation of the `GitHub.RepositoryEventSource` tag.
 *
 * The Octokit client is stubbed with canned pages (the credentials
 * service's `octokit()` returns the stub), so no API key and no network.
 * Under `it.effect` the TestClock starts frozen at epoch 0: each
 * registration's cursor initializes to 0, canned entity timestamps are
 * small positive epoch offsets (all "new activity"), and
 * `TestClock.adjust` steps the poll schedule deterministically. The
 * polling Layer wraps each whole test body in ONE `Effect.provide`
 * (owner convention) — its Scope owns the poll fibers for exactly the
 * test's duration.
 *
 * Asserted:
 * (a) only the REQUESTED events are polled (no REST call for the rest),
 *     and `consumeRepositoryEvents` hands the handler TYPED events;
 * (b) synthesized deliveries PARSE into the same typed union verified
 *     webhook deliveries do (tags, principal fields, identity keys);
 * (c) raw delivery ids are deterministic — two registrations (= two
 *     poll cursors, the restart scenario) over the same data see EQUAL
 *     ids, each id once per registration (dedupe is the consumer's job);
 * (d) the cursor advances — a later poll with newer data yields only
 *     the delta, never a re-delivery of what an earlier poll saw.
 */
import * as GitHub from "@/GitHub/index.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

const repo = { owner: "alchemy-run", repository: "test-alchemy" };

// the resource is how consumers name the repository — the deferred
// constructor's declared identity resolves WITHOUT a Stack
const testAlchemy = GitHub.Repository("polling-test-alchemy", {
  owner: repo.owner,
  name: repo.repository,
});

/** Epoch-offset ISO timestamps (TestClock starts at 0). */
const T = (seconds: number) => new Date(seconds * 1000).toISOString();

// ─── the canned REST pages ────────────────────────────────────────

interface StubIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  created_at: string;
  closed_at: string | null;
  pull_request?: object;
}

interface StubComment {
  id: number;
  body: string;
  user: { login: string } | null;
  created_at: string;
  issue_url: string;
}

interface StubPull {
  number: number;
  title: string;
  created_at: string;
  closed_at: string | null;
  merged_at: string | null;
}

const makeStub = () => {
  const data = {
    issues: [] as StubIssue[],
    comments: [] as StubComment[],
    pulls: [] as StubPull[],
  };
  const calls: string[] = [];
  // only the three endpoints the polling Layer may touch exist on the
  // stub — a call to anything else is a TypeError, which test (a)
  // relies on alongside the recorded call list
  const octokit = {
    rest: {
      issues: {
        listForRepo: () => {
          calls.push("issues.listForRepo");
          return Promise.resolve({ data: [...data.issues] });
        },
        listCommentsForRepo: () => {
          calls.push("issues.listCommentsForRepo");
          return Promise.resolve({ data: [...data.comments] });
        },
      },
      pulls: {
        list: () => {
          calls.push("pulls.list");
          return Promise.resolve({ data: [...data.pulls] });
        },
      },
    },
  };
  const credentials = Layer.succeed(
    GitHub.GitHubCredentials,
    Effect.succeed({
      token: Redacted.make("stub-token"),
      octokit: () => octokit as never,
    }),
  );
  // the polling Layer under test, wired to this stub
  const layer = GitHub.RepositoryEventSourcePolling({
    every: "30 seconds",
  }).pipe(Layer.provide(credentials));
  return { data, calls, layer };
};

const issue = (number: number, props: Partial<StubIssue> = {}): StubIssue => ({
  number,
  title: `issue #${number}`,
  body: "body",
  state: "open",
  created_at: T(1),
  closed_at: null,
  ...props,
});

const comment = (id: number, issueNumber: number, at: string): StubComment => ({
  id,
  body: "any update?",
  user: { login: "reporter" },
  created_at: at,
  issue_url: `https://api.github.com/repos/${repo.owner}/${repo.repository}/issues/${issueNumber}`,
});

/** Register on the RAW service — delivery ids live below the typed wire. */
const consumeRaw = (
  events: readonly GitHub.WebhookEventName[],
  handler: (event: GitHub.WebhookEvent) => Effect.Effect<void>,
) =>
  GitHub.RepositoryEventSource.use((source) =>
    source({ ...repo, events }, handler),
  );

describe("GitHub.RepositoryEventSourcePolling", () => {
  it.effect(
    "(a) polls only the requested events; the handler gets typed events",
    () => {
      const stub = makeStub();
      stub.data.issues = [issue(7, { created_at: T(1) })];
      stub.data.comments = [comment(501, 7, T(2))];
      stub.data.pulls = [
        {
          number: 9,
          title: "pr #9",
          created_at: T(3),
          closed_at: null,
          merged_at: null,
        },
      ];

      return Effect.gen(function* () {
        const inbox = yield* Queue.unbounded<GitHub.IssuesEvent>();
        yield* GitHub.consumeRepositoryEvents(
          testAlchemy,
          {
            events: [
              GitHub.IssueOpened,
              GitHub.IssueLabeled,
              GitHub.IssueClosed,
            ],
          },
          (event) => Queue.offer(inbox, event).pipe(Effect.asVoid),
        );

        // only the issue's opened event arrives — TYPED — even though the
        // stub holds a comment and a PR too…
        const delivered = yield* Queue.take(inbox);
        expect(delivered._tag).toBe("IssueOpened");

        // …and the un-requested endpoints were never called
        expect(stub.calls).toContain("issues.listForRepo");
        expect(stub.calls).not.toContain("issues.listCommentsForRepo");
        expect(stub.calls).not.toContain("pulls.list");
      }).pipe(Effect.provide(stub.layer));
    },
  );

  it.effect(
    "(b) synthesized deliveries parse into the typed union like webhook ones",
    () => {
      const stub = makeStub();
      stub.data.issues = [
        issue(7, { created_at: T(1) }),
        // created BEFORE the window opened (pre-epoch created_at) —
        // only the close is in-window
        issue(5, { state: "closed", created_at: T(-60), closed_at: T(2) }),
      ];
      stub.data.comments = [comment(501, 7, T(3))];
      stub.data.pulls = [
        {
          number: 9,
          title: "pr #9",
          created_at: T(4),
          merged_at: T(5),
          closed_at: T(5),
        },
      ];

      return Effect.gen(function* () {
        const inbox = yield* Queue.unbounded<
          GitHub.IssuesEvent | GitHub.IssueCommented | GitHub.PullRequestEvent
        >();
        yield* GitHub.consumeRepositoryEvents(
          testAlchemy,
          {
            events: [
              GitHub.IssueOpened,
              GitHub.IssueLabeled,
              GitHub.IssueClosed,
              GitHub.IssueCommented,
              GitHub.PullRequestOpened,
              GitHub.PullRequestMerged,
              GitHub.PullRequestClosed,
            ],
          },
          (event) => Queue.offer(inbox, event).pipe(Effect.asVoid),
        );

        // ordered by entity timestamp; merges arrive as their OWN tag —
        // consumers never re-derive closed+merged
        const events = yield* Queue.takeN(inbox, 5);
        expect(events.map((e) => e._tag)).toEqual([
          "IssueOpened",
          "IssueClosed",
          "IssueCommented",
          "PullRequestOpened",
          "PullRequestMerged",
        ]);

        const [opened, closed, commented, prOpened, prMerged] = events;
        // every event carries the repository and its entity in full
        expect(opened!.repository).toEqual({
          name: repo.repository,
          owner: { login: repo.owner },
        });
        expect(opened!._tag === "IssueOpened" && opened!.issue.number).toBe(7);
        expect(opened!._tag === "IssueOpened" && opened!.issue.title).toBe(
          "issue #7",
        );
        expect(
          commented!._tag === "IssueCommented" && commented!.comment.body,
        ).toBe("any update?");
        expect(
          commented!._tag === "IssueCommented" && commented!.issue.number,
        ).toBe(7);
        expect(
          prOpened!._tag === "PullRequestOpened" && prOpened!.pullRequest.title,
        ).toBe("pr #9");

        // the identity key is ONE function over the typed union — the
        // same key routing names runs with and exits settle by
        expect(GitHub.eventKey(closed!)).toBe(
          `${repo.owner}/${repo.repository}#5`,
        );
        expect(GitHub.eventKey(prMerged!)).toBe(
          `${repo.owner}/${repo.repository}#9`,
        );
      }).pipe(Effect.provide(stub.layer));
    },
  );

  it.effect(
    "(c) delivery ids are deterministic and EQUAL across registrations (restart)",
    () => {
      const stub = makeStub();
      stub.data.issues = [
        issue(7, { created_at: T(1) }),
        issue(5, { state: "closed", created_at: T(-60), closed_at: T(2) }),
      ];
      stub.data.comments = [comment(501, 7, T(3))];

      return Effect.gen(function* () {
        // two registrations = two independent cursors, both starting at
        // "now" (0) — the restart scenario, same canned data. Delivery
        // ids live on the RAW wire (the typed events carry entity
        // identity instead — GitHub.eventKey).
        const first = yield* Queue.unbounded<GitHub.WebhookEvent>();
        const second = yield* Queue.unbounded<GitHub.WebhookEvent>();
        yield* consumeRaw(["issues", "issue_comment"], (event) =>
          Queue.offer(first, event).pipe(Effect.asVoid),
        );
        yield* consumeRaw(["issues", "issue_comment"], (event) =>
          Queue.offer(second, event).pipe(Effect.asVoid),
        );

        const firstIds = (yield* Queue.takeN(first, 3)).map((e) => e.id);
        const secondIds = (yield* Queue.takeN(second, 3)).map((e) => e.id);

        // ids are EQUAL across the two cursors (ledger dedupe holds
        // across restarts), and each id arrived once per registration
        expect(firstIds).toEqual(secondIds);
        expect(new Set(firstIds).size).toBe(3);

        // the format is pinned: a pure function of the entity, never of
        // poll time
        expect(firstIds).toEqual([
          `poll/${repo.owner}/${repo.repository}/issues.opened/7/${T(1)}`,
          `poll/${repo.owner}/${repo.repository}/issues.closed/5/${T(2)}`,
          `poll/${repo.owner}/${repo.repository}/issue_comment.created/501/${T(3)}`,
        ]);
      }).pipe(Effect.provide(stub.layer));
    },
  );

  it.effect("(d) the cursor advances: later polls yield only the delta", () => {
    const stub = makeStub();
    stub.data.issues = [issue(1, { created_at: T(1) })];

    return Effect.gen(function* () {
      const seen: string[] = [];
      const inbox = yield* Queue.unbounded<GitHub.WebhookEvent>();
      yield* consumeRaw(["issues"], (event) =>
        Effect.gen(function* () {
          seen.push(event.id);
          yield* Queue.offer(inbox, event);
        }),
      );

      // poll 1 (immediate): issue #1 arrives
      const opened1 = yield* Queue.take(inbox);
      expect(opened1.id).toContain("/issues.opened/1/");

      // poll 2 (same data): the cursor advanced past #1 — no re-delivery
      yield* TestClock.adjust("30 seconds");

      // newer data appears; the next poll yields ONLY the delta
      stub.data.issues.push(issue(2, { created_at: T(10) }));
      yield* TestClock.adjust("30 seconds");
      const opened2 = yield* Queue.take(inbox);
      expect(opened2.id).toContain("/issues.opened/2/");

      // across all polls: #1 exactly once, #2 exactly once, nothing else
      expect(seen).toEqual([opened1.id, opened2.id]);
    }).pipe(Effect.provide(stub.layer));
  });
});
