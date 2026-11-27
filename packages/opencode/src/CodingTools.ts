import * as AI from "@alchemy.run/ai";
import { Sandbox } from "@alchemy.run/ai/Sandbox";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/** The most of a command's output or a file the model is given. */
const MAX_CHARS = 30_000;

/** The end of `text`, which is where a command says what went wrong. */
const tail = (text: string) =>
  text.length <= MAX_CHARS
    ? text
    : `[${text.length - MAX_CHARS} characters cut]\n${text.slice(-MAX_CHARS)}`;

/**
 * `AI.Bash` for OpenCode: a shell command in the session's sandbox.
 * OpenCode itself runs in the Durable Object, where there is no shell.
 */
export const Bash = AI.Bash.make(
  {
    description:
      "Run a shell command in the sandbox and return what it printed. The working directory does not carry from one call to the next: use absolute paths, or cd inside the command.",
    parameters: Schema.Struct({
      command: Schema.String.annotate({ description: "The shell command to run" }),
      timeout: Schema.optional(
        Schema.Number.annotate({ description: "Seconds to wait before giving up (default 120)" }),
      ),
    }),
    success: Schema.Struct({
      exitCode: Schema.Number,
      stdout: Schema.String,
      stderr: Schema.String,
    }),
  },
  Effect.fn(function* ({ command, timeout }) {
    const sandbox = yield* Sandbox;
    const result = yield* sandbox
      .exec(["bash", "-lc", command], { timeout: (timeout ?? 120) * 1000 })
      .pipe(Effect.orDie);
    return {
      exitCode: result.exitCode,
      stdout: tail(result.stdout),
      stderr: tail(result.stderr),
    };
  }),
);

/** `AI.Read` for OpenCode: a text file from the sandbox, with line numbers. */
export const Read = AI.Read.make(
  {
    description:
      "Read a text file from the sandbox. Returns its lines numbered from 1. Use offset and limit for a long file.",
    parameters: Schema.Struct({
      path: Schema.String.annotate({ description: "Path of the file" }),
      offset: Schema.optional(
        Schema.Number.annotate({ description: "First line to return, from 1 (default 1)" }),
      ),
      limit: Schema.optional(
        Schema.Number.annotate({ description: "How many lines to return (default 2000)" }),
      ),
    }),
    success: Schema.Struct({
      content: Schema.String,
      /** Lines in the whole file. */
      lines: Schema.Number,
    }),
    replay: "safe",
  },
  Effect.fn(function* ({ path, offset, limit }) {
    const sandbox = yield* Sandbox;
    const all = (yield* sandbox.readTextFile(path).pipe(Effect.orDie)).split("\n");
    const first = Math.max(1, offset ?? 1);
    return {
      content: tail(
        all
          .slice(first - 1, first - 1 + (limit ?? 2000))
          .map((line, index) => `${first + index}\t${line}`)
          .join("\n"),
      ),
      lines: all.length,
    };
  }),
);

/** `AI.Write` for OpenCode: a whole file in the sandbox, with its directories. */
export const Write = AI.Write.make(
  {
    description:
      "Write a whole file in the sandbox, creating its directories and replacing what was there.",
    parameters: Schema.Struct({
      path: Schema.String.annotate({ description: "Path of the file" }),
      content: Schema.String.annotate({ description: "The file's full content" }),
    }),
    success: Schema.Struct({ bytes: Schema.Number }),
  },
  Effect.fn(function* ({ path, content }) {
    const sandbox = yield* Sandbox;
    yield* sandbox
      .exec(["sh", "-c", 'mkdir -p "$(dirname "$1")"', "mkdir", path])
      .pipe(Effect.orDie);
    yield* sandbox.writeFile(path, content).pipe(Effect.orDie);
    return { bytes: new TextEncoder().encode(content).length };
  }),
);

/** `AI.Edit` for OpenCode: replace exact text in a file in the sandbox. */
export const Edit = AI.Edit.make(
  {
    description:
      "Replace exact text in a file in the sandbox. oldText must match the file exactly and only once: include enough surrounding lines to make it unique.",
    parameters: Schema.Struct({
      path: Schema.String.annotate({ description: "Path of the file" }),
      oldText: Schema.String.annotate({ description: "The exact text to replace" }),
      newText: Schema.String.annotate({ description: "What to put in its place" }),
    }),
    success: Schema.Struct({ bytes: Schema.Number }),
  },
  Effect.fn(function* ({ path, oldText, newText }) {
    const sandbox = yield* Sandbox;
    const before = yield* sandbox.readTextFile(path).pipe(Effect.orDie);
    const found = before.split(oldText).length - 1;
    if (oldText.length === 0 || found !== 1) {
      return yield* Effect.die(
        new Error(
          found === 0
            ? `oldText was not found in ${path}`
            : `oldText matches ${found} places in ${path}: add surrounding lines so it matches one`,
        ),
      );
    }
    const index = before.indexOf(oldText);
    const after = `${before.slice(0, index)}${newText}${before.slice(index + oldText.length)}`;
    yield* sandbox.writeFile(path, after).pipe(Effect.orDie);
    return { bytes: new TextEncoder().encode(after).length };
  }),
);

/**
 * Shell that sets `p` to the path in `$1`, with a leading `~` as the home
 * directory: a path given as an argument is not expanded by a shell.
 */
const HOME_PATH = 'p=$1; case $p in "~") p=$HOME ;; "~/"*) p=$HOME/${p#"~/"} ;; esac';

const MAX_LINES = 200;

const lines = (text: string) => {
  const all = text.split("\n").filter((line) => line.length > 0);
  return {
    matches: all.slice(0, MAX_LINES),
    truncated: all.length > MAX_LINES,
  };
};

const Found = Schema.Struct({
  matches: Schema.Array(Schema.String),
  /** More matched than are listed. */
  truncated: Schema.Boolean,
});

/** `AI.Grep` for OpenCode: `grep -rnE` in the sandbox. */
export const Grep = AI.Grep.make(
  {
    description: `Search file contents with a regular expression. Returns matching lines as path:line:text, at most ${MAX_LINES}. Narrow the search with path or include when there are more.`,
    parameters: Schema.Struct({
      pattern: Schema.String.annotate({ description: "Extended regular expression to search for" }),
      path: Schema.optional(
        Schema.String.annotate({ description: "File or directory to search (default: .)" }),
      ),
      include: Schema.optional(
        Schema.String.annotate({
          description: 'Only search files matching this glob, e.g. "*.ts"',
        }),
      ),
    }),
    success: Found,
    replay: "safe",
  },
  Effect.fn(function* ({ pattern, path, include }) {
    const sandbox = yield* Sandbox;
    const result = yield* sandbox
      .exec([
        "bash",
        "-c",
        `${HOME_PATH}; shift; exec grep -rnE --exclude-dir=.git --exclude-dir=node_modules "$@" "$p"`,
        "grep",
        path ?? ".",
        ...(include === undefined ? [] : [`--include=${include}`]),
        "--",
        pattern,
      ])
      .pipe(Effect.orDie);
    // grep exits 1 when nothing matches, and 2 when it could not search.
    if (result.exitCode > 1) {
      return yield* Effect.die(new Error(result.stderr.trim() || "grep could not search"));
    }
    return lines(result.stdout);
  }),
);

/** `AI.Glob` for OpenCode: a `bash` glob in the sandbox. */
export const Glob = AI.Glob.make(
  {
    description: `Find files by glob pattern, such as "src/**/*.ts". Returns matching paths, at most ${MAX_LINES}.`,
    parameters: Schema.Struct({
      pattern: Schema.String.annotate({ description: "Glob pattern; ** matches any depth" }),
      path: Schema.optional(
        Schema.String.annotate({ description: "Directory to search from (default: .)" }),
      ),
    }),
    success: Found,
    replay: "safe",
  },
  Effect.fn(function* ({ pattern, path }) {
    const sandbox = yield* Sandbox;
    const result = yield* sandbox
      .exec([
        "bash",
        "-O",
        "globstar",
        "-O",
        "nullglob",
        "-c",
        // An empty IFS keeps a pattern with spaces whole while it still expands.
        `${HOME_PATH}; cd "$p" && IFS= && printf "%s\\n" $2`,
        "glob",
        path ?? ".",
        pattern,
      ])
      .pipe(Effect.orDie);
    if (result.exitCode !== 0) {
      return yield* Effect.die(new Error(result.stderr.trim() || "glob could not search"));
    }
    return lines(result.stdout);
  }),
);

/**
 * A Layer for every tool in `AI.CodingTools`. OpenCode runs in the Durable
 * Object, which has no files or shell, so each tool works in the session's
 * sandbox: the Layer requires `AI.Sandboxes`.
 */
export const CodingTools = Layer.mergeAll(Bash, Read, Edit, Write, Grep, Glob);
