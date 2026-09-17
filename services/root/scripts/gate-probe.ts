/**
 * Ask the gate about a few messages, straight against the real API —
 * the quick loop for eyeballing one message's verdict. The
 * authoritative scorecard (scenarios + expectations) is
 * `bun test test/gate.test.ts`.
 *
 * `bun scripts/gate-probe.ts [root|engineering] ["a message…"]`
 */
import * as TS from "@distilled.cloud/typesafe-ai";
import { RuntimeContext } from "alchemy";
import type * as TypeSafe from "alchemy/TypeSafe";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { judge, type Respondent } from "../src/chat/Gate.ts";

const MESSAGES = [
  "hey",
  "hey manager",
  "start me a thread on something",
  "hey manager, start a thread and ask the engineer what is our testing policy",
  "thanks!",
  "what is our testing policy?",
  "the dev worker OOMs when importing the distilled repo — please dig into the pack ingest path",
  "review #1594 and tell me if the storage math is right",
];

/** The rooms, as ChannelsApi declares them. */
const ROOMS: Record<string, ReadonlyArray<Respondent>> = {
  root: ["head"],
  engineering: ["manager", "engineer", "reviewer"],
};
const CHANNEL = process.argv[2] ?? "engineering";
const roster = ROOMS[CHANNEL]!;
const messages = process.argv[3] !== undefined ? [process.argv[3]] : MESSAGES;

const query = ((questions, options) =>
  TS.query(questions, options).pipe(
    Effect.provide([TS.CredentialsFromEnv, FetchHttpClient.layer]),
  )) as typeof TypeSafe.SystemOne.Service;

const probe = Effect.fn(function* (message: string) {
  const verdict = yield* judge(query, {
    channel: CHANNEL,
    message,
    roster,
    recent: [],
  });
  if (verdict === undefined) {
    console.log(`—       —     → —         ${message.slice(0, 64)}`);
    return;
  }
  console.log(
    `${verdict.disposition.padEnd(7)} ${verdict.confidence.toFixed(2).padEnd(5)} → ${verdict.respondent.padEnd(9)}${verdict.addressed ? "@" : " "} ${message.slice(0, 64)}`,
  );
});

await Effect.runPromise(
  Effect.forEach(messages, probe, { concurrency: 4 }).pipe(
    Effect.provide(RuntimeContext.phantom),
  ),
);
