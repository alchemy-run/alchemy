/**
 * Streaming tail consumer for {@link AsyncWorker}. Listed in the producer's
 * `streamingTailConsumers`, so every invocation of the producer opens a
 * streaming session against `tailStream()`: the handler is invoked with the
 * invocation's `onset` event while the producer is still executing, and the
 * returned function receives every subsequent event (`log`, ...) ending with
 * the terminal `outcome`. Completed sessions are recorded into a KV
 * namespace and exposed over `GET /events` so the integ test can assert the
 * producer's `console.log` marker streamed end-to-end.
 *
 * NOTE: the default export must be this module's ONLY export — extra named
 * exports become workerd top-level exports and fail startup validation.
 */
interface TailEventsKV {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  list(options?: { prefix?: string }): Promise<{ keys: { name: string }[] }>;
}

interface StreamTailEvent {
  invocationId?: string;
  timestamp?: string;
  sequence?: number;
  event?: {
    type?: string;
    outcome?: string;
    level?: string;
    message?: unknown;
    info?: { type?: string; url?: string; method?: string };
  };
}

export default {
  async fetch(
    request: Request,
    env: { EVENTS: TailEventsKV },
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/events") {
      const list = await env.EVENTS.list({ prefix: "evt:" });
      const sessions = await Promise.all(
        list.keys.map((key) => env.EVENTS.get(key.name)),
      );
      return Response.json({
        keys: list.keys.map((key) => key.name),
        sessions: sessions.filter(
          (session): session is string => session !== null,
        ),
      });
    }
    return new Response("stream-tail-consumer-ok");
  },
  tailStream(
    onset: StreamTailEvent,
    env: { EVENTS: TailEventsKV },
  ): (tailEvent: StreamTailEvent) => Promise<void> {
    const events: StreamTailEvent[] = [onset];
    return async (tailEvent: StreamTailEvent): Promise<void> => {
      events.push(tailEvent);
      if (tailEvent.event?.type === "outcome") {
        const id = onset.invocationId ?? `${Date.now()}`;
        await env.EVENTS.put(
          `evt:${id}:${Date.now()}`,
          JSON.stringify(events),
        );
      }
    };
  },
};
