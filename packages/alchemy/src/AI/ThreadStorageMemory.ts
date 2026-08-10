import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Prompt from "effect/unstable/ai/Prompt";
import type { SessionObservation } from "./EventStream.ts";
import {
  ThreadStorage,
  type InboxRow,
  type SessionMeta,
  type ThreadHandle,
  type ThreadStorageService,
} from "./ThreadStorage.ts";

interface MemorySession {
  meta: SessionMeta | undefined;
  messages: Array<Prompt.MessageEncoded>;
  log: Array<SessionObservation>;
  inbox: Array<InboxRow>;
  inboxSeq: number;
  drained: number;
}

/**
 * One in-memory `ThreadStorage` instance: plain Maps, exactly as
 * durable as the process. Also what hosts hand ephemeral sessions
 * (a spawn worker inside a Durable Object).
 */
export const makeThreadStorageMemory = (): ThreadStorageService => {
  {
    const sessions = new Map<string, MemorySession>();
    const row = (term: string, key: string): MemorySession => {
      const id = `${term}\u0000${key}`;
      let session = sessions.get(id);
      if (session === undefined) {
        session = {
          meta: undefined,
          messages: [],
          log: [],
          inbox: [],
          inboxSeq: 0,
          drained: 0,
        };
        sessions.set(id, session);
      }
      return session;
    };
    return ThreadStorage.of({
      open: (term, key) =>
        Effect.sync(() => {
          const session = row(term, key);
          return {
            meta: Effect.sync(() => session.meta),
            putMeta: (meta) =>
              Effect.sync(() => {
                session.meta = meta;
              }),
            putInbox: (input, inboxOptions) =>
              Effect.sync(() => {
                const seq = session.inboxSeq++;
                session.inbox.push({
                  seq,
                  input,
                  quiet: inboxOptions?.quiet === true,
                });
                return seq;
              }),
            listInbox: Effect.sync(() =>
              session.inbox.filter(
                (inboxRow) => inboxRow.seq >= session.drained,
              ),
            ),
            deleteInbox: (seqs) =>
              Effect.sync(() => {
                const drop = new Set(seqs);
                session.inbox = session.inbox.filter(
                  (inboxRow) => !drop.has(inboxRow.seq),
                );
              }),
            admit: ({ messages, drainedTo, meta }) =>
              Effect.sync(() => {
                session.messages.push(...messages);
                session.drained = drainedTo;
                session.meta = meta;
              }),
            messages: Effect.sync(() => session.messages),
            appendMessages: (messages) =>
              Effect.sync(() => {
                session.messages.push(...messages);
              }),
            replaceMessages: (messages) =>
              Effect.sync(() => {
                session.messages = [...messages];
              }),
            appendObservation: (observation, meta) =>
              Effect.sync(() => {
                session.log.push(observation);
                // ring: mirror the chat projection's eviction policy
                if (session.log.length > 2000) session.log.splice(0, 500);
                session.meta = meta;
              }),
            observations: (fromSeq) =>
              Effect.sync(() =>
                session.log.filter((observation) => observation.seq >= fromSeq),
              ),
          } satisfies ThreadHandle;
        }),
      // a fresh build has no keys (nothing survives the process), but a
      // REUSED instance restores — which is what lets a test drive the
      // restore path without sqlite: build a second driver over the
      // same ThreadStorageMemory value and the parked sessions come back
      keys: (term) =>
        Effect.sync(() => {
          const prefix = `${term}\u0000`;
          const found: Array<string> = [];
          for (const [id, session] of sessions) {
            if (id.startsWith(prefix) && session.meta !== undefined) {
              found.push(id.slice(prefix.length));
            }
          }
          return found;
        }),
      remove: (term, key) =>
        Effect.sync(() => {
          sessions.delete(`${term}\u0000${key}`);
        }),
    });
  }
};

/**
 * The in-memory `ThreadStorage` Layer — the ephemeral substrate for
 * `DriverLocal`. Fresh state per Layer build (layers memoize by
 * reference, so one assembly shares one store).
 */
export const ThreadStorageMemory: Layer.Layer<ThreadStorage> = Layer.sync(
  ThreadStorage,
  makeThreadStorageMemory,
);
