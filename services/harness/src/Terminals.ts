import { SessionError } from "@alchemy.run/ai";
import type { RuntimeContext } from "alchemy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Sandbox } from "./Sandbox.ts";

/** Output kept for clients that (re)connect: enough to redraw a screen or two. */
const HISTORY_BYTES = 64 * 1024;

interface Shell {
  /** Owns the shell process; closing it kills the shell. */
  readonly scope: Scope.Closeable;
  readonly input: Queue.Queue<string>;
  readonly output: PubSub.PubSub<string>;
  readonly resize: (cols: number, rows: number) => Effect.Effect<void, never, RuntimeContext>;
  /** Recent output, starting at a line break so it never begins mid escape sequence. */
  history: string;
}

const failure = (cause: unknown) =>
  SessionError.make({
    message: `terminal: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

/**
 * Shells in the session's container, one per key, on a real terminal (a
 * pty). A shell outlives the clients watching it: they come and go, and
 * each one that connects gets the recent output first.
 */
export class Terminals extends Context.Service<
  Terminals,
  {
    /** A shell's output: the recent history, then live until it exits. */
    readonly output: (
      key: string,
      cols: number,
      rows: number,
    ) => Stream.Stream<string, SessionError, RuntimeContext>;
    /** Keystrokes for a running shell. */
    readonly input: (key: string, data: string) => Effect.Effect<void, SessionError>;
    readonly resize: (
      key: string,
      cols: number,
      rows: number,
    ) => Effect.Effect<void, never, RuntimeContext>;
  }
>()("harness/Terminals") {}

/** {@link Terminals} over `Sandbox`'s container: shells start in `cwd`. */
export const TerminalsLive = (options: { readonly cwd: string }) =>
  Layer.effect(Terminals)(
    Effect.gen(function* () {
      const sandbox = yield* Sandbox;
      const shells = new Map<string, Shell>();

      const remember = (shell: Shell, chunk: string) => {
        const history = shell.history + chunk;
        if (history.length <= HISTORY_BYTES) {
          shell.history = history;
          return;
        }
        const cut = history.indexOf("\n", history.length - HISTORY_BYTES);
        shell.history = cut === -1 ? "" : history.slice(cut + 1);
      };

      const start = Effect.fn(function* (key: string, cols: number, rows: number) {
        const scope = yield* Scope.make();
        const child = yield* sandbox
          .exec(["bash", "-l"], {
            pty: { cols, rows },
            stdin: "pipe",
            stdout: "pipe",
            cwd: options.cwd,
            env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
          })
          .pipe(Scope.provide(scope));
        const shell: Shell = {
          scope,
          input: yield* Queue.unbounded<string>(),
          output: yield* PubSub.unbounded<string>(),
          resize: (c, r) => child.resize(c, r).pipe(Effect.ignore),
          history: "",
        };
        const encoder = new TextEncoder();
        // Keystrokes → the shell's stdin.
        if (child.stdin) {
          yield* Stream.fromQueue(shell.input).pipe(
            Stream.map((data) => encoder.encode(data)),
            Stream.run(child.stdin),
            Effect.ignore,
            Effect.forkIn(scope),
          );
        }
        // The shell's output → every client, until it exits.
        yield* (child.stdout ?? Stream.empty).pipe(
          Stream.decodeText,
          Stream.runForEach((chunk) =>
            Effect.sync(() => remember(shell, chunk)).pipe(
              Effect.andThen(PubSub.publish(shell.output, chunk)),
            ),
          ),
          Effect.ignore,
          Effect.ensuring(
            Effect.suspend(() => {
              if (shells.get(key) === shell) shells.delete(key);
              return PubSub.shutdown(shell.output).pipe(
                Effect.andThen(Scope.close(scope, Exit.void)),
              );
            }),
          ),
          Effect.forkIn(scope),
        );
        shells.set(key, shell);
        return shell;
      });

      /** The shell for `key`, started if it isn't running. */
      const shell = (key: string, cols: number, rows: number) =>
        Effect.suspend(() => {
          const existing = shells.get(key);
          return existing
            ? existing.resize(cols, rows).pipe(Effect.as(existing))
            : start(key, cols, rows);
        });

      return Terminals.of({
        output: (key, cols, rows) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const s = yield* shell(key, cols, rows);
              const subscription = yield* PubSub.subscribe(s.output);
              return Stream.concat(
                s.history ? Stream.succeed(s.history) : Stream.empty,
                Stream.fromSubscription(subscription),
              );
            }),
          ).pipe(Stream.scoped, Stream.mapError(failure)),

        input: (key, data) =>
          Effect.suspend(() => {
            const s = shells.get(key);
            return s
              ? Queue.offer(s.input, data).pipe(Effect.asVoid)
              : Effect.fail(failure("no shell is running"));
          }),

        resize: (key, cols, rows) =>
          Effect.suspend(() => shells.get(key)?.resize(cols, rows) ?? Effect.void),
      });
    }),
  );
