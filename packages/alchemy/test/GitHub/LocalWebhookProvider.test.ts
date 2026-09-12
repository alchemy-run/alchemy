/**
 * Scripted tests for the dev-mode webhook emulator
 * (`GitHub.LocalWebhookProvider`'s `emulateWebhook` loop): a stubbed
 * Octokit serves canned REST pages (no network to GitHub), a real Bun
 * HTTP server plays the local Worker, and the TestClock steps the poll
 * schedule.
 *
 * Asserted:
 * (a) a synthesized delivery arrives as a REAL webhook POST — event and
 *     delivery headers, a valid `x-hub-signature-256` HMAC over the
 *     exact body (verified by recomputation), and a payload the wire
 *     shape expects;
 * (b) an unacknowledged delivery (receiver answers 503) is retried on
 *     the next tick with the SAME deterministic id, and once
 *     acknowledged is never delivered again.
 */
import { emulateWebhook } from "@/GitHub/LocalWebhookProvider.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

const repo = { owner: "alchemy-run", repository: "test-alchemy" };
const T = (seconds: number) => new Date(seconds * 1000).toISOString();

/** Only `pulls.list` exists — the loop must not touch anything else. */
const stubOctokit = (pulls: ReadonlyArray<unknown>) =>
  ({
    rest: {
      pulls: { list: () => Promise.resolve({ data: [...pulls] }) },
    },
  }) as never;

interface Received {
  readonly event: string | null;
  readonly delivery: string | null;
  readonly signature: string | null;
  readonly body: string;
}

/** The "local Worker": captures deliveries, answers a scripted status. */
const makeReceiver = Effect.gen(function* () {
  const inbox = yield* Queue.unbounded<Received>();
  let status = 202;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      Queue.offerUnsafe(inbox, {
        event: request.headers.get("x-github-event"),
        delivery: request.headers.get("x-github-delivery"),
        signature: request.headers.get("x-hub-signature-256"),
        body: await request.text(),
      });
      return new Response(null, { status });
    },
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)));
  return {
    inbox,
    url: `http://localhost:${server.port}/api/github/webhook`,
    setStatus: (next: number) => {
      status = next;
    },
  };
});

/** Recompute the HMAC the receiver would verify. */
const expectedSignature = async (secret: string, body: string) => {
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
};

const pull = {
  number: 9,
  title: "pr #9",
  body: "Closes #7",
  created_at: T(3),
  closed_at: null,
  merged_at: null,
};

describe("GitHub.LocalWebhookProvider", () => {
  it.effect("(a) delivers a signed, header-complete webhook POST", () =>
    Effect.gen(function* () {
      const receiver = yield* makeReceiver;
      yield* emulateWebhook(stubOctokit([pull]), {
        ...repo,
        url: receiver.url,
        events: ["pull_request"],
        secret: Redacted.make("s3cret"),
      }).pipe(Effect.forkScoped);

      const received = yield* Queue.take(receiver.inbox);
      expect(received.event).toBe("pull_request");
      expect(received.delivery).toBe(
        `poll/${repo.owner}/${repo.repository}/pull_request.opened/9/${T(3)}`,
      );
      expect(received.signature).toBe(
        yield* Effect.promise(() => expectedSignature("s3cret", received.body)),
      );
      const payload = JSON.parse(received.body) as {
        action: string;
        pull_request: { number: number; merged: boolean };
        repository: { name: string; owner: { login: string } };
      };
      expect(payload.action).toBe("opened");
      expect(payload.pull_request.number).toBe(9);
      expect(payload.repository.owner.login).toBe(repo.owner);
    }),
  );

  it.effect("(b) an unacknowledged delivery retries, then never repeats", () =>
    Effect.gen(function* () {
      const receiver = yield* makeReceiver;
      receiver.setStatus(503);
      yield* emulateWebhook(stubOctokit([pull]), {
        ...repo,
        url: receiver.url,
        events: ["pull_request"],
        secret: undefined,
      }).pipe(Effect.forkScoped);

      // first attempt: refused — the cursor must not advance
      const first = yield* Queue.take(receiver.inbox);
      expect(first.signature).toBeNull();

      // next tick redelivers the SAME id, now acknowledged
      receiver.setStatus(202);
      yield* TestClock.adjust("10 seconds");
      const second = yield* Queue.take(receiver.inbox);
      expect(second.delivery).toBe(first.delivery);

      // further ticks deliver nothing — the id is settled
      yield* TestClock.adjust("10 seconds");
      yield* TestClock.adjust("10 seconds");
      expect(yield* Queue.size(receiver.inbox)).toBe(0);
    }),
  );
});
