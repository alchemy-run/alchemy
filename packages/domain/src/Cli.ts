import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Headers from "effect/http/Headers";
import * as Option from "effect/Option";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import type * as Scope from "effect/Scope";
import type { Entry } from "./Api.ts";
import { describe, type Operation } from "./ApiCatalog.ts";

/**
 * A command line for an Api: one subcommand per entry, run as a client of the
 * deployed Api over its HTTP protocol. Not part of the Domain core: import it
 * from `@alchemy.run/domain/Cli`, so an app that builds no CLI never loads
 * `effect/cli`.
 */

/** What {@link toCli} reads from an Api class. */
export interface Cliable {
  readonly apiName: string;
  readonly entries: ReadonlyArray<Entry>;
  readonly group: RpcGroup.RpcGroup<Rpc.Any>;
  readonly client: Effect.Effect<unknown, never, any>;
}

/** The services an Api's client needs, less the scope each run opens itself. */
export type ClientServices<A extends Cliable> =
  A["client"] extends Effect.Effect<any, any, infer R> ? Exclude<R, Scope.Scope> : never;

/**
 * The Api answered with a typed failure: a declared rejection, or the error
 * of the middleware that guards the call. The CLI has already written
 * `error` (its wire JSON) to stderr, so `runMain` exits with code 1 and
 * prints nothing more.
 */
export class CallRejected extends Data.TaggedError("CallRejected")<{
  /** The RPC that rejected the call (`Deposit`, `Balance.get`). */
  readonly rpc: string;
  /** The failure as wire JSON: what the Api's catalog describes as `error`. */
  readonly error: unknown;
}> {
  override readonly [Runtime.errorReported] = false;
}

/** How {@link toCli} builds the command line. */
export interface Options<E = never, R = never> {
  /** The root command: the name a person types. Default: the Api's name in kebab-case. */
  readonly name?: string;
  /** The root command's help text. */
  readonly description?: string;
  /**
   * Headers sent with every call, such as a bearer token for the session
   * middleware that runs on the server. An Effect runs once per call, so it
   * can read the token from the environment (`Config.redacted("TOKEN")`).
   */
  readonly headers?: Headers.Input | Effect.Effect<Headers.Input, E, R>;
}

/** The errors a command of the CLI fails with. */
export type Failure<E = never> = CallRejected | CliError.UserError | E;

// ---------------------------------------------------------------- naming

/**
 * The command-line name of an entry, an operation or a field: kebab-case
 * (`AccountSummary` → `account-summary`, `commandId` → `command-id`).
 */
export const kebab = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[\s_.]+/g, "-")
    .toLowerCase();

/** Flags every command has, or that the Effect CLI reads before any command. */
const RESERVED = new Set(["json", "help", "version", "wizard", "completions", "log-level"]);

// ---------------------------------------------------------------- flags

/** How a field of the wire input is typed on the command line. */
type FieldKind =
  | { readonly _tag: "string" }
  | { readonly _tag: "number" }
  | { readonly _tag: "boolean" }
  | { readonly _tag: "choice"; readonly literals: ReadonlyArray<string> }
  | { readonly _tag: "json" };

interface Field {
  /** The payload field (`commandId`). */
  readonly name: string;
  /** Its flag (`command-id`). */
  readonly flag: string;
  readonly kind: FieldKind;
  readonly required: boolean;
  readonly description: string | undefined;
}

const membersOf = (ast: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> =>
  SchemaAST.isUnion(ast) ? ast.types.flatMap(membersOf) : [ast];

/**
 * A string, a number, a boolean or a set of string literals takes a typed
 * flag. Anything else (a struct, an array, a date) takes its JSON.
 */
const kindOf = (ast: SchemaAST.AST): FieldKind => {
  const members = membersOf(ast).filter((member) => !SchemaAST.isUndefined(member));
  if (members.length === 1) {
    const [member] = members as [SchemaAST.AST];
    if (SchemaAST.isString(member)) return { _tag: "string" };
    if (SchemaAST.isNumber(member)) return { _tag: "number" };
    if (SchemaAST.isBoolean(member)) return { _tag: "boolean" };
  }
  const literals = members.flatMap((member) =>
    SchemaAST.isLiteral(member) && typeof member.literal === "string" ? [member.literal] : [],
  );
  return members.length > 0 && literals.length === members.length
    ? { _tag: "choice", literals }
    : { _tag: "json" };
};

const descriptionOfField = (ast: SchemaAST.AST): string | undefined =>
  SchemaAST.resolveDescription(ast) ??
  membersOf(ast)
    .map((member) => SchemaAST.resolveDescription(member))
    .find((description) => description !== undefined);

/** The fields of a call's payload, as the wire carries them (the encoded side). */
const fieldsOf = (where: string, payload: Schema.Top): ReadonlyArray<Field> => {
  const ast = SchemaAST.toEncoded(payload.ast);
  if (!SchemaAST.isObjects(ast)) return [];
  const flags = new Map<string, string>();
  return ast.propertySignatures.map((property) => {
    const name = String(property.name);
    const flag = kebab(name);
    const taken = flags.get(flag);
    if (RESERVED.has(flag) || taken !== undefined) {
      throw new Error(
        `${where}: field \`${name}\` would be the flag --${flag}, ` +
          (taken === undefined ? "which the CLI reserves" : `as is field \`${taken}\``),
      );
    }
    flags.set(flag, name);
    return {
      name,
      flag,
      kind: kindOf(property.type),
      required: !SchemaAST.isOptional(property.type),
      description: descriptionOfField(property.type),
    };
  });
};

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

const flagOf = (field: Field): Flag.Flag<Option.Option<unknown>> => {
  const { kind, flag } = field;
  const base: Flag.Flag<unknown> =
    kind._tag === "string"
      ? Flag.String(flag)
      : kind._tag === "number"
        ? Flag.Finite(flag)
        : kind._tag === "boolean"
          ? Flag.Boolean(flag)
          : kind._tag === "choice"
            ? Flag.Literals(flag, kind.literals)
            : Flag.String(flag).pipe(Flag.withMetavar("json"));
  const help = [
    field.description === undefined ? undefined : sentence(field.description),
    kind._tag === "json" ? "A JSON value." : undefined,
    field.required ? "Required." : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" ");
  return base.pipe(
    (flag) => (help === "" ? flag : Flag.withDescription(flag, help)),
    Flag.optional,
  );
};

const JsonFlag = Flag.String("json").pipe(
  Flag.withMetavar("json"),
  Flag.withDescription("The whole input as a JSON object. Flags override its fields."),
  Flag.optional,
);

// ---------------------------------------------------------------- calls

/** A JSON flag's value: its JSON, or the text itself when it is not JSON (a date, an id). */
const parseValue = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** The first message along an error's causes. */
const messageOf = (error: unknown): string => {
  for (let at = error, depth = 0; at !== undefined && depth < 5; depth++) {
    const { message, reason, cause } = at as {
      message?: unknown;
      reason?: { message?: unknown; cause?: unknown };
      cause?: unknown;
    };
    const own = [reason?.message, message].find((m) => typeof m === "string" && m.trim() !== "");
    if (own !== undefined && !/^\w+: ?$/.test(String(own))) return String(own);
    at = reason?.cause ?? cause;
  }
  return String(error);
};

const userError = (message: string, cause?: unknown) =>
  CliError.UserError.make({ cause: cause ?? message, userMessage: message });

/** Invoke one call through the Api's typed client, with the decoded payload. */
const invoke = (
  client: unknown,
  op: Operation,
  payload: Record<string, unknown>,
  headers: Headers.Input | undefined,
): Effect.Effect<unknown, unknown> => {
  const entry = (client as Record<string, unknown>)[op.entry];
  if (op.kind === "Command") {
    return (entry as (payload: unknown, options: unknown) => Effect.Effect<unknown, unknown>)(
      payload,
      { headers },
    );
  }
  const { key, ...options } = payload;
  const read = (entry as Record<string, (key: unknown, options: unknown) => unknown>)[
    op.operation
  ]!;
  return read(key, { ...options, headers }) as Effect.Effect<unknown, unknown>;
};

/**
 * The CLI runs every request/response call. Live reads (`watch`, `events`)
 * are streams, so they stay out. Once entries declare `expose`, an entry
 * whose `exposureOf(entry).cli` is `false` stays out here too.
 */
const published = (op: Operation): boolean => !op.stream;

/**
 * An entry's help text: the description the Api's catalog gives it, or what
 * it is (`Send the Deposit command.`, `Read the Balance view.`). Once
 * entries declare `description`, this reads it with `descriptionOf(entry)`.
 */
const descriptionOf = (operations: ReadonlyArray<Operation>): string => {
  const [first] = operations as [Operation];
  const described = operations.find((op) => op.description !== undefined)?.description;
  if (described !== undefined) return described;
  return first.kind === "Command"
    ? `Send the ${first.entry} command.`
    : `Read the ${first.entry} ${first.kind.toLowerCase()}.`;
};

/** What each read prints, for its help. */
const READS: Record<string, string> = {
  get: "Print the key's current state.",
  peek: "Print the key's latest entry.",
  list: "Print a page of the key's entries.",
};

const commandOf = <E, R>(
  api: Cliable,
  op: Operation,
  name: string,
  options: Options<E, R>,
): Command.Command<string, unknown, {}, Failure<E>, R> => {
  // The group's RPC also carries middleware applied to the whole Api.
  const rpc = api.group.requests.get(op.rpc)! as Rpc.AnyWithProps;
  const fields = fieldsOf(`${api.apiName} ${op.rpc}`, rpc.payloadSchema);
  const decodePayload = Schema.decodeUnknownEffect(Schema.toCodecJson(rpc.payloadSchema));
  const encodeSuccess = Schema.encodeUnknownEffect(Schema.toCodecJson(rpc.successSchema));
  // Errors decode with no services, so they encode with none.
  const failures = [rpc.errorSchema, ...[...rpc.middlewares].map((m) => m.error)].filter(
    (schema): schema is Schema.Codec<unknown, unknown> =>
      schema !== undefined && !SchemaAST.isNever(schema.ast),
  );
  const config: Record<string, Flag.Flag<Option.Option<unknown>>> = { json: JsonFlag };
  for (const field of fields) config[field.name] = flagOf(field);

  /** A typed failure goes to stderr as its wire JSON; anything else did not reach the Api. */
  const failed = (error: unknown): Effect.Effect<never, CallRejected | CliError.UserError> => {
    const schema = failures.find((schema) => Schema.is(schema)(error));
    if (!schema) {
      return Effect.fail(userError(`${op.rpc} did not reach the Api: ${messageOf(error)}`, error));
    }
    return Schema.encodeUnknownEffect(Schema.toCodecJson(schema))(error).pipe(
      Effect.orDie,
      Effect.tap((wire) => Console.error(JSON.stringify(wire, null, 2))),
      Effect.flatMap((wire) => Effect.fail(new CallRejected({ rpc: op.rpc, error: wire }))),
    );
  };

  const handler = (parsed: Record<string, Option.Option<unknown>>) =>
    Effect.gen(function* () {
      const wire: Record<string, unknown> = {};
      const json = parsed.json as Option.Option<string>;
      if (Option.isSome(json)) {
        const value = yield* Effect.try({
          try: () => JSON.parse(json.value) as unknown,
          catch: (cause) => userError(`--json is not valid JSON: ${String(cause)}`, cause),
        });
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          return yield* userError("--json must be a JSON object");
        }
        Object.assign(wire, value);
      }
      for (const field of fields) {
        const value = parsed[field.name]!;
        if (Option.isNone(value)) continue;
        wire[field.name] =
          field.kind._tag === "json" ? parseValue(value.value as string) : value.value;
      }
      const payload = yield* decodePayload(wire).pipe(
        Effect.mapError((error) => userError(`Invalid input for ${name}: ${error.message}`, error)),
      );
      const headers =
        options.headers === undefined
          ? undefined
          : Effect.isEffect(options.headers)
            ? yield* options.headers
            : options.headers;
      const client = yield* api.client;
      const success = yield* invoke(client, op, payload as Record<string, unknown>, headers).pipe(
        Effect.catch(failed),
      );
      const out = yield* encodeSuccess(success).pipe(Effect.orDie);
      yield* Console.log(JSON.stringify(out, null, 2));
    }).pipe(Effect.scoped);

  return Command.make(name, config, handler as never) as never;
};

/**
 * An Effect CLI command for an Api: a client that calls the deployed Api over
 * its HTTP protocol, so a person or an agent in a terminal can run any
 * request/response call. The tree is read from `Domain.Api.describe`:
 *
 * - each entry is a subcommand named in kebab-case (`AccountSummary` →
 *   `account-summary`). A command runs as that subcommand; a view, an
 *   aggregate or a stream has one subcommand per call (`get`, `list`,
 *   `peek`). Live reads (`watch`, `events`) are left out.
 * - each payload field is a flag in kebab-case (`--target`, `--command-id`,
 *   `--key`). A string, a number, a boolean or a set of string literals
 *   takes a typed flag; any other field takes its JSON (`--at-least
 *   '{"stream":"Account/a-1","version":3}'`). `--json` takes the whole input
 *   as one object, and flags override its fields.
 * - the input is decoded against the call's schema before anything is sent;
 *   an invalid input fails as a `CliError.UserError`.
 * - the result is printed to stdout as JSON (its wire form). A typed
 *   failure (a rejection, or the error of the middleware that guards the
 *   call) is printed to stderr as JSON and fails the run with
 *   {@link CallRejected}, so the process exits with code 1.
 *
 * Provide the protocol to the command (`Domain.protocolHttp(url)` and an
 * `HttpClient`), and the platform's CLI services to run it.
 *
 * **Example:** A CLI for an Api
 * ```typescript
 * import { toCli } from "@alchemy.run/domain/Cli";
 * import * as Domain from "@alchemy.run/domain";
 * import { BunRuntime, BunServices } from "@effect/platform-bun";
 * import * as Command from "effect/cli/Command";
 * import * as Config from "effect/Config";
 * import * as Effect from "effect/Effect";
 * import * as FetchHttpClient from "effect/http/FetchHttpClient";
 * import * as Redacted from "effect/Redacted";
 * import { CustomerApi } from "./CustomerApi.ts";
 *
 * const bank = toCli(CustomerApi, {
 *   name: "bank",
 *   headers: Config.redacted("BANK_TOKEN").pipe(
 *     Effect.map((token) => ({ authorization: `Bearer ${Redacted.value(token)}` })),
 *   ),
 * });
 *
 * Command.run(bank, { version: "1.0.0" }).pipe(
 *   Effect.provide(Domain.protocolHttp("https://bank.example.com/api")),
 *   Effect.provide(FetchHttpClient.layer),
 *   Effect.provide(BunServices.layer),
 *   BunRuntime.runMain,
 * );
 * // $ bank deposit-money --target a-1 --amount 1000
 * // $ bank account-summary get --key a-1
 * ```
 */
export const toCli = <A extends Cliable, E = never, R = never>(
  api: A,
  options: Options<E, R> = {},
): Command.Command<string, unknown, {}, Failure<E>, ClientServices<A> | R> => {
  const catalog = describe(api);
  const byEntry = new Map<string, Array<Operation>>();
  for (const op of catalog.operations) {
    const ops = byEntry.get(op.entry) ?? [];
    ops.push(op);
    byEntry.set(op.entry, ops);
  }
  const names = new Map<string, string>();
  const subcommands: Array<Command.Command<string, unknown, {}, Failure<E>, R>> = [];
  for (const [entry, all] of byEntry) {
    const name = kebab(entry);
    const taken = names.get(name);
    if (taken !== undefined) {
      throw new Error(
        `${api.apiName}: entries \`${taken}\` and \`${entry}\` are both the command ${name}`,
      );
    }
    names.set(name, entry);
    const ops = all.filter(published);
    if (ops.length === 0) continue;
    const description = descriptionOf(all);
    let command: Command.Command<string, unknown, {}, Failure<E>, R>;
    if (all[0]!.kind === "Command") {
      command = commandOf(api, ops[0]!, name, options);
    } else {
      command = Command.make(name).pipe(
        Command.withSubcommands(
          ops.map((op) =>
            commandOf(api, op, op.operation, options).pipe(
              Command.withDescription(READS[op.operation] ?? op.operation),
            ),
          ) as never,
        ),
      ) as never;
    }
    subcommands.push(Command.withDescription(command, description));
  }
  const root = Command.make(options.name ?? kebab(api.apiName)).pipe(
    Command.withSubcommands(subcommands as never),
  );
  return (
    options.description === undefined ? root : Command.withDescription(root, options.description)
  ) as never;
};
