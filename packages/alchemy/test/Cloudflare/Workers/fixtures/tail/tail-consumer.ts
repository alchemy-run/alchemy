/**
 * Async (non-Effect) Tail Worker fixture for `TailConsumers.test.ts`.
 *
 * Cloudflare invokes the exported `tail()` handler with the trace items of
 * each invocation of any producer Worker that lists this script in its
 * `tail_consumers`. Every batch is persisted to the bound KV namespace under
 * a key prefixed with the *producing* script's name, so the test verifies
 * delivery out-of-band (distilled KV reads) without depending on which
 * isolate served which request.
 */

interface TailEventsKV {
  put(key: string, value: string): Promise<void>;
}

interface TraceItemLite {
  scriptName?: string | null;
  outcome?: string;
  logs?: { message?: unknown[]; level?: string; timestamp?: number }[];
}

export default {
  async fetch(): Promise<Response> {
    return new Response("tail-consumer-ok");
  },
  async tail(
    events: TraceItemLite[],
    env: { EVENTS: TailEventsKV },
  ): Promise<void> {
    const producer = events[0]?.scriptName ?? "unknown";
    await env.EVENTS.put(
      `evt:${producer}:${Date.now()}`,
      JSON.stringify(events),
    );
  },
};
