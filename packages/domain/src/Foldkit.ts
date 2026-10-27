import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Headers from "effect/http/Headers";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, type Subscription } from "foldkit";
import { defineMessageUnion, type MessageUnion } from "foldkit/message";
import type * as Api from "./Api.ts";
import type * as DomainCommand from "./Command.ts";
import * as Key from "./Key.ts";
import type * as View from "./View.ts";

/** Per-call headers, resolved at execution time and excluded from replayable args. */
export class CommandHeaders extends Context.Service<
  CommandHeaders,
  {
    readonly get: (command: string) => Effect.Effect<Headers.Input>;
  }
>()("@alchemy.run/domain/Foldkit/CommandHeaders") {}

/** Page-local command id state. Give each page load a fresh session in Flags. */
export const CommandIds = Schema.Struct({ session: Schema.String, sent: Schema.Number });
/** Page-local command id state. */
export type CommandIds = typeof CommandIds.Type;

/** Allocate an id without reading time or changing the supplied state. */
export const next = (ids: CommandIds) => ({
  commandId: `${ids.session}:${ids.sent}`,
  commandIds: CommandIds.make({ session: ids.session, sent: ids.sent + 1 }),
});

type Input<C extends DomainCommand.Any> = Omit<C["Type"], "_tag">;
type Reply<C extends DomainCommand.Any> = C["reply"] extends Schema.Top ? C["reply"]["Type"] : void;
type Rejection<C extends DomainCommand.Any> = C["rejects"][number]["Type"];
type Denial<C extends DomainCommand.Any> = C["middleware"][number]["error"]["Type"];

/** A refusal is final; an unknown outcome can be retried with the same id. */
export type Failure<C extends DomainCommand.Any> =
  | Readonly<{ _tag: "Rejected"; rejection: Rejection<C> }>
  | Readonly<{ _tag: "Denied"; error: Denial<C> }>
  | Readonly<{ _tag: "Unknown" }>;

type Cases<A extends Api.Any> = {
  readonly [C in Api.CommandsOf<A> as `Succeeded${C["tag"]}`]: {
    commandId: typeof Schema.String;
    reply: Schema.Schema<Reply<C>>;
    receipt: Schema.Struct<{ stream: typeof Schema.String; version: typeof Schema.Number }>;
  };
} & {
  readonly [C in Api.CommandsOf<A> as `Failed${C["tag"]}`]: {
    commandId: typeof Schema.String;
    failure: Schema.Schema<Failure<C>>;
  };
};

type Args<C extends DomainCommand.Any> = {
  target: Schema.toType<C["target"]>;
  input: Schema.Schema<Input<C>>;
  commandId: typeof Schema.String;
};
type Result<A extends Api.Any, C extends DomainCommand.Any> = Extract<
  MessageUnion<Cases<A>>["Type"],
  { readonly _tag: `Succeeded${C["tag"]}` | `Failed${C["tag"]}` }
>;

/** Typed Command definitions and their result Message union, derived from an Api. */
export type Commands<A extends Api.Any> = {
  readonly [C in Api.CommandsOf<A> as C["tag"]]: Command.CommandDefinitionWithArgs<
    C["tag"],
    Args<C>,
    Effect.Effect<
      Result<A, C>,
      never,
      A["Client"]["Identifier"] | Effect.Services<ReturnType<Api.CommandClient<C>>>
    >
  >;
} & { readonly Message: MessageUnion<Cases<A>> };

const Receipt = Schema.Struct({ stream: Schema.String, version: Schema.Number });

/** Build one Foldkit Command per Api command. Provide the Api client at the runtime boundary. */
export function commands<A extends Api.Any>(api: A): Commands<A>;
export function commands(api: Api.Any): unknown {
  const cases: Record<string, Schema.Struct.Fields> = {};
  for (const command of api.commands) {
    const rejection = Schema.Union(command.rejects);
    const denial = Schema.Union(command.middleware.map((middleware) => middleware.error));
    cases[`Succeeded${command.tag}`] = {
      commandId: Schema.String,
      reply: command.reply ?? Schema.Void,
      receipt: Receipt,
    };
    cases[`Failed${command.tag}`] = {
      commandId: Schema.String,
      failure: Schema.Union([
        Schema.TaggedStruct("Rejected", { rejection }),
        Schema.TaggedStruct("Denied", { error: denial }),
        Schema.TaggedStruct("Unknown", {}),
      ]),
    };
  }
  const Message = defineMessageUnion(cases);
  const definitions: Record<string, unknown> = { Message };
  for (const command of api.commands) {
    const { payloadSchema } = command.rpc as Rpc.AnyWithProps;
    if (
      !("fields" in payloadSchema) ||
      !Predicate.isObject(payloadSchema.fields) ||
      !("input" in payloadSchema.fields) ||
      !Schema.isSchema(payloadSchema.fields.input)
    ) {
      continue;
    }
    definitions[command.tag] = Command.define(command.tag, {
      args: {
        target: Schema.toType(command.target),
        input: Schema.toType(payloadSchema.fields.input),
        commandId: Schema.String,
      },
      messages: [Message],
      execute: ({ target, input, commandId }) =>
        Effect.gen(function* () {
          const client = (yield* Effect.service(api.Client)) as Record<
            string,
            (
              target: string,
              input: unknown,
              options: Api.CommandOptions,
            ) => Effect.Effect<{ reply: unknown; stream: string; version: number }, unknown>
          >;
          const headersService = yield* Effect.serviceOption(CommandHeaders);
          const headers =
            headersService._tag === "Some"
              ? yield* headersService.value.get(command.tag)
              : undefined;
          return yield* client[command.tag](target, input, { commandId, headers }).pipe(
            Effect.map(({ reply, stream, version }) => ({
              _tag: `Succeeded${command.tag}`,
              commandId,
              reply,
              receipt: { stream, version },
            })),
            Effect.catch((error) =>
              Effect.succeed({
                _tag: `Failed${command.tag}`,
                commandId,
                failure: classifyFailure(command, error),
              }),
            ),
          );
        }),
    });
  }
  return definitions;
}

const classifyFailure = (command: DomainCommand.Any, error: unknown) => {
  if (command.rejects.some((rejection) => Schema.is(rejection)(error))) {
    return { _tag: "Rejected", rejection: error };
  }
  if (command.middleware.some((middleware) => Schema.is(middleware.error)(error))) {
    return { _tag: "Denied", error };
  }
  return { _tag: "Unknown" };
};

type Views<A extends Api.Any> = Extract<A["entries"][number], View.Any>;
type ViewNamed<A extends Api.Any, Name extends Views<A>["viewName"]> = Extract<
  Views<A>,
  { readonly viewName: Name }
>;
type ViewKey<V extends View.Any> = Key.IdOf<View.KeyOf<V>>;

/** A watch Snapshot with explicit absence for Foldkit Models. */
export type Snapshot<State> = Readonly<{
  state: Option.Option<NonNullable<State>>;
  cursor: number;
}>;

/** Callbacks for a View's live state. Cursor changes do not restart the watch. */
export interface WatchOptions<Model, Message, V extends View.Any> {
  readonly key: (model: Model) => ViewKey<V>;
  readonly isEnabled?: (model: Model) => boolean;
  readonly toMessage: (snapshot: Snapshot<View.StateOf<V>>) => Message;
  readonly onFailure: (error: Api.ReadError<V["definition"]>) => Message;
}

/** Follow a View's state and cursor. Pass the result as an entry to Subscription.make. */
export function watchView<A extends Api.Any, Name extends Views<A>["viewName"], Model, Message>(
  api: A,
  name: Name,
  options: WatchOptions<Model, Message, ViewNamed<A, Name>>,
): Subscription.EntryWithoutKeepAlive<
  Model,
  Message,
  { key: ViewKey<ViewNamed<A, Name>>; isEnabled: boolean },
  A["Client"]["Identifier"]
>;
export function watchView(
  api: Api.Any,
  name: string,
  options: WatchOptions<unknown, unknown, View.Any>,
): unknown {
  const view = api.entries.find(
    (entry): entry is View.Any => entry.kind === "View" && entry.viewName === name,
  )!;
  return {
    dependenciesSchema: Schema.Struct({
      key: Schema.toType(Key.idSchemaOf(view.definition.key)),
      isEnabled: Schema.Boolean,
    }),
    modelToDependencies: (model: unknown) => ({
      key: options.key(model),
      isEnabled: options.isEnabled?.(model) ?? true,
    }),
    dependenciesToStream: ({ key, isEnabled }: { key: string; isEnabled: boolean }) =>
      isEnabled
        ? Stream.unwrap(
            Effect.map(Effect.service(api.Client), (client) =>
              (client as Record<string, Api.ViewClient<View.Any>>)[name].watch(key),
            ),
          ).pipe(
            Stream.map(({ state, cursor }) =>
              options.toMessage({ state: Option.fromNullishOr(state), cursor }),
            ),
            Stream.catch((error) => Stream.succeed(options.onFailure(error))),
          )
        : Stream.empty,
  };
}
