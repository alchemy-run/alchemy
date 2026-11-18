import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Predicate from "effect/Predicate";
import { ChildProcess } from "effect/process";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import type { ProtonPassResolvedCredentials } from "../AuthProvider.ts";
import {
  ProtonPassAuthError,
  ProtonPassCliError,
  ProtonPassCliNotFoundError,
  ProtonPassDuplicateFieldError,
  ProtonPassItemError,
  ProtonPassNotLoggedInError,
  ProtonPassReferenceError,
  ProtonPassTimeoutError,
  type ProtonPassOperation,
  type ProtonPassReferenceErrorType,
} from "../Errors.ts";

const COMMAND = "pass-cli";

/** References resolved at once; each is one short CLI call. */
const READ_CONCURRENCY = 4;

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run `pass-cli` without a shell or a terminal, so it can never prompt.
 * Credentials travel only in `env`, never in argv where `ps` would show them.
 */
const run = (
  operation: ProtonPassOperation,
  args: ReadonlyArray<string>,
  env: Record<string, string>,
) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make(COMMAND, [...args], {
      shell: false,
      env: { PROTON_PASS_NO_UPDATE_CHECK: "1", ...env },
      extendEnv: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = yield* Effect.all(
      [
        handle.exitCode,
        handle.stdout.pipe(Stream.decodeText, Stream.mkString),
        handle.stderr.pipe(Stream.decodeText, Stream.mkString),
      ],
      { concurrency: 3 },
    );
    return { exitCode: Number(exitCode), stdout, stderr } satisfies CliResult;
  }).pipe(
    Effect.scoped,
    // The spawn error may carry the environment, so only its kind is kept.
    Effect.mapError((cause: unknown) =>
      isNotFound(cause)
        ? new ProtonPassCliNotFoundError({ command: COMMAND })
        : new ProtonPassCliError({ operation }),
    ),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(new ProtonPassTimeoutError({ operation })),
    }),
  );

const isNotFound = (cause: unknown) =>
  (Predicate.hasProperty(cause, "reason") &&
    Predicate.hasProperty(cause.reason, "_tag") &&
    cause.reason._tag === "NotFound") ||
  String(Predicate.hasProperty(cause, "message") ? cause.message : cause).includes("ENOENT");

const notLoggedIn = (stderr: string) =>
  /requires an authenticated client|there is no session|not logged in/i.test(stderr);

/** Classify a failed read by the CLI's fixed phrases; the message itself is dropped. */
const referenceErrorType = (stderr: string): ProtonPassReferenceErrorType | undefined =>
  /invalid (item )?reference|invalid reference format/i.test(stderr)
    ? "parsing"
    : /could not find vault|vault .*not found/i.test(stderr)
      ? "vaultNotFound"
      : /could not find item|item .*not found/i.test(stderr)
        ? "itemNotFound"
        : /field does not exist|field .*not found/i.test(stderr)
          ? "fieldNotFound"
          : undefined;

/** `item view` ends a field value with one newline of its own. */
const stripTrailingNewline = (value: string) => value.replace(/\r?\n$/, "");

/**
 * A personal access token logs in to a throwaway session directory, so the
 * user's own `pass-cli` session is never replaced. The session is logged out
 * and the directory removed when the scope closes.
 */
const sessionEnv = Effect.fn("proton-pass.session")(function* (
  credentials: ProtonPassResolvedCredentials,
) {
  if (credentials.method === "cli-session") return {};
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs
    .makeTempDirectoryScoped({ prefix: "alchemy-proton-pass-" })
    .pipe(Effect.mapError(() => new ProtonPassCliError({ operation: "login" })));
  const env = { PROTON_PASS_SESSION_DIR: directory, PROTON_PASS_KEY_PROVIDER: "fs" };
  const login = yield* run("login", ["login"], {
    ...env,
    PROTON_PASS_PERSONAL_ACCESS_TOKEN: Redacted.value(credentials.token),
  });
  if (login.exitCode !== 0) return yield* new ProtonPassAuthError();
  // Logging out revokes the session server-side; a failure there loses nothing.
  yield* Effect.addFinalizer(() => run("logout", ["logout"], env).pipe(Effect.ignore));
  return env;
});

/** A failed read is a missing session, or the caller's error for the classified kind. */
const readError = <E>(
  stderr: string,
  onRead: (errorType?: ProtonPassReferenceErrorType) => E,
): ProtonPassNotLoggedInError | E =>
  notLoggedIn(stderr) ? new ProtonPassNotLoggedInError() : onRead(referenceErrorType(stderr));

/**
 * Resolve `pass://vault/item/field` references keyed by their config keys.
 * Each distinct reference is read once; if any fails, nothing is returned.
 */
export const resolveReferences = Effect.fn("proton-pass.resolveReferences")(function* (
  references: Readonly<Record<string, string>>,
  credentials: ProtonPassResolvedCredentials,
) {
  const env = yield* sessionEnv(credentials);
  const keyOf = new Map<string, string>();
  for (const [configKey, reference] of Object.entries(references)) {
    if (!keyOf.has(reference)) keyOf.set(reference, configKey);
  }
  const values = new Map<string, string>();
  yield* Effect.forEach(
    [...keyOf],
    ([reference, configKey]) =>
      Effect.gen(function* () {
        const result = yield* run("read", ["item", "view", reference], env);
        if (result.exitCode !== 0) {
          return yield* readError(
            result.stderr,
            (errorType) => new ProtonPassReferenceError({ configKey, errorType }),
          );
        }
        values.set(reference, stripTrailingNewline(result.stdout));
      }),
    { concurrency: READ_CONCURRENCY, discard: true },
  );
  const loaded: Record<string, string> = Object.create(null);
  for (const [configKey, reference] of Object.entries(references)) {
    loaded[configKey] = values.get(reference)!;
  }
  return loaded;
}, Effect.scoped);

interface ItemField {
  readonly name: string;
  readonly content: Readonly<Record<string, unknown>>;
}

interface ItemView {
  readonly item: {
    readonly content: {
      readonly content: Readonly<Record<string, unknown>>;
      readonly extra_fields?: ReadonlyArray<ItemField>;
    };
  };
}

const fieldsOf = (view: ItemView): ReadonlyArray<ItemField> => {
  const fields: ItemField[] = [...(view.item.content.extra_fields ?? [])];
  for (const variant of Object.values(view.item.content.content)) {
    if (!Predicate.hasProperty(variant, "sections") || !Array.isArray(variant.sections)) continue;
    for (const section of variant.sections as ReadonlyArray<{ section_fields?: ItemField[] }>) {
      fields.push(...(section.section_fields ?? []));
    }
  }
  return fields;
};

/** Text and hidden fields only: TOTP seeds and timestamps are not config. */
const textValue = (field: ItemField) => {
  const value = field.content.Text ?? field.content.Hidden;
  return Predicate.isString(value) ? value : undefined;
};

/**
 * Read every text and hidden custom field of one item, under its field name.
 * Fields in sections are included without their section prefix.
 */
export const readItem = Effect.fn("proton-pass.readItem")(function* (
  source: { readonly vault: string; readonly item: string },
  credentials: ProtonPassResolvedCredentials,
) {
  const env = yield* sessionEnv(credentials);
  const result = yield* run(
    "read",
    ["item", "view", `pass://${source.vault}/${source.item}`, "--output", "json"],
    env,
  );
  if (result.exitCode !== 0) {
    return yield* readError(
      result.stderr,
      (errorType) => new ProtonPassItemError({ ...source, errorType }),
    );
  }
  const view = yield* Effect.try({
    try: () => JSON.parse(result.stdout) as ItemView,
    catch: () => new ProtonPassCliError({ operation: "read" }),
  });
  const values: Record<string, string> = Object.create(null);
  for (const field of yield* Effect.try({
    try: () => fieldsOf(view),
    catch: () => new ProtonPassCliError({ operation: "read" }),
  })) {
    const value = textValue(field);
    if (value === undefined) continue;
    if (field.name in values) {
      return yield* new ProtonPassDuplicateFieldError({ item: source.item, field: field.name });
    }
    values[field.name] = value;
  }
  return values;
}, Effect.scoped);
