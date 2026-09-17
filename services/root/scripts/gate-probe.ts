/**
 * Ask the gate's rubric about a set of messages, straight against the
 * real API — the loop for tuning question wording without a deploy.
 *
 * `bun scripts/gate-probe.ts`
 */
import {
  asChoice,
  CredentialsFromEnv,
  query,
} from "@distilled.cloud/typesafe-ai";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { questions } from "../src/chat/Gate.ts";

const MESSAGES = [
  "can the head guy say hi back",
  "i mean without a thread",
  "nothing",
  "thanks!",
  "hey",
  "what is the org working on right now?",
  "is the dev server on 1337 or 1340?",
  "who owns the Cloudflare provider?",
  "the dev worker OOMs when importing the distilled repo — please dig into the pack ingest path",
  "please add a Railway volume resource with tests",
  "review #1594 and tell me if the storage math is right",
];

const probe = Effect.fn(function* (message: string) {
  const verdict = yield* query(questions, {
    state: {
      channel: "root",
      message,
      roster: ["head", "manager", "engineer", "reviewer"],
    },
  });
  const disposition = asChoice(verdict.answers.disposition);
  console.log(
    `${verdict.value.disposition.padEnd(7)} ${String(disposition?.confidence.toFixed(2)).padEnd(5)} → ${verdict.value.respondent.padEnd(9)} ${message.slice(0, 64)}`,
  );
});

await Effect.runPromise(
  Effect.forEach(MESSAGES, probe, { concurrency: 4 }).pipe(
    Effect.provide([CredentialsFromEnv, FetchHttpClient.layer]),
  ),
);
