/**
 * Streaming tail collector for native-tracing local tests.
 *
 * Default export must be this module's ONLY export — extra named exports
 * become workerd top-level exports and fail startup validation.
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
  spanContext?: { traceId?: string; spanId?: string };
  event?: {
    type?: string;
    name?: string;
    spanId?: string;
    outcome?: string;
    level?: string;
    message?: unknown;
    info?: unknown;
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
    return new Response("native-tracing-collector-ok");
  },
  tailStream(
    onset: StreamTailEvent,
    env: { EVENTS: TailEventsKV },
  ): (tailEvent: StreamTailEvent) => Promise<void> {
    const slim = (entry: StreamTailEvent): StreamTailEvent => ({
      invocationId: entry.invocationId,
      spanContext: entry.spanContext,
      event:
        entry.event === undefined
          ? undefined
          : {
              type: entry.event.type,
              name: entry.event.name,
              spanId: entry.event.spanId,
              outcome: entry.event.outcome,
              message: entry.event.message,
              info:
                entry.event.type === "attributes"
                  ? entry.event.info
                  : undefined,
            },
    });
    const events: StreamTailEvent[] = [slim(onset)];
    return async (tailEvent: StreamTailEvent): Promise<void> => {
      events.push(slim(tailEvent));
      if (tailEvent.event?.type === "outcome") {
        const id = onset.invocationId ?? `${Date.now()}`;
        await env.EVENTS.put(`evt:${id}`, JSON.stringify(events));
      }
    };
  },
};
