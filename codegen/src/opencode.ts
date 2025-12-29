import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import {
  OpencodeClient,
  createOpencode,
  type Session as OpencodeSession,
} from "@opencode-ai/sdk";

export type ToEffect<T> = T extends (...args: infer Args) => infer Out
  ? (
      ...args: Args
    ) => Effect.Effect<
      Awaited<Out> extends { data: infer Data } ? Data : Awaited<Out>,
      any
    >
  : T extends object
    ? {
        [K in keyof T]: ToEffect<T[K]>;
      }
    : T;

export class OpencodeError extends Data.TaggedError("OpencodeError")<{
  message: string;
}> {}

export class Opencode extends Context.Tag("Opencode")<
  Opencode,
  {
    client: ToEffect<OpencodeClient>;
    server: {
      url: string;
      close(): void;
    };
  }
>() {}

export class Session extends Context.Tag("Session")<
  Session,
  {
    session: OpencodeSession;
    prompt(
      input:
        | string
        | {
            prompt: string;
            model?: { providerID: string; modelID: string } | undefined;
            noReply?: boolean;
          },
    ): Effect.Effect<void, OpencodeError>;
    branch(title: string): Effect.Effect<OpencodeSession, OpencodeError>;
  }
>() {
  static from = (session: OpencodeSession) =>
    Layer.effect(
      Session,
      Effect.gen(function* () {
        const { client } = yield* Opencode;
        return Session.of({
          session,
          branch: Effect.fn(function* (title) {
            const prevSession = ((yield* client.session.list({})) ?? []).find(
              (s) => s.parentID === session.id && s.title === title,
            );
            if (prevSession) {
              console.log(
                `Reusing existing session: ${prevSession.id} for branch: ${title}`,
              );
            }
            const sesh =
              prevSession ??
              (yield* client.session.create({
                body: {
                  parentID: session.id,
                  title,
                },
              }));
            if (!sesh) {
              return yield* Effect.dieMessage("Failed to branch session");
            }
            return sesh;
          }),
          prompt: (_input) => {
            const input =
              typeof _input === "string" ? { prompt: _input } : _input;
            return client.session.prompt({
              path: { id: session.id },
              body: {
                // TODO(sam): select an agent with temperature <= 0.1
                // agent: "",
                model: input.model ?? {
                  providerID: "anthropic",
                  modelID: "claude-opus-4-5-20251101",
                },
                noReply: input.noReply ?? false,
                parts: [
                  {
                    type: "text",
                    text: input.prompt,
                  },
                ],
              },
            });
          },
        });
      }),
    );
}

export const opencode = Layer.effect(
  Opencode,
  // TODO(sam): connect to a persistent server process
  Effect.promise(async () => {
    const { client, server } = await createOpencode();
    const proxy = (value: any) =>
      new Proxy(value, {
        get: (target, prop, receiver) => {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value === "function") {
            return Effect.fnUntraced(function* (...args: any[]) {
              return yield* Effect.tryPromise({
                try: async () => {
                  const output = await value.apply(target, args);
                  return "data" in output ? output.data : output;
                },
                catch: (cause: any) =>
                  new OpencodeError({ message: cause.message }),
              });
            });
          } else if (typeof value === "object" && value !== null) {
            return proxy(value);
          } else {
            return value;
          }
        },
      }) as any;
    return {
      client: proxy(client),
      server,
    };
  }),
);
