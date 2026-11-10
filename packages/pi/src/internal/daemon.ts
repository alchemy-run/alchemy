/**
 * Runs the pi-env daemon in a sandbox and carries its byte stream over the
 * two calls every sandbox platform has: a command run to completion, and a
 * background command whose output is followed.
 *
 * A process's stdin is not used. Platforms differ too much there: some pass
 * bytes, some only text, some close it after the first write, some have
 * none. Instead the daemon reads a FIFO, and each batch of bytes is written
 * to it by its own short command. The daemon's output is printed as base64
 * lines, so it survives a platform that carries output as text.
 *
 * @internal
 */
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as SandboxApi from "alchemy/Sandbox";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { OpenDaemon } from "./pienv.ts";

/** The sandbox calls the daemon needs. */
export interface DaemonSandbox {
  exec(
    command: SandboxApi.Command,
    options?: any,
  ): Effect.Effect<{ readonly exitCode: number }, unknown, RuntimeContext>;
  start(
    command: SandboxApi.Command,
    options?: any,
  ): Effect.Effect<
    {
      readonly output: Stream.Stream<SandboxApi.ProcessOutput, unknown, RuntimeContext>;
      kill(): Effect.Effect<unknown, unknown, RuntimeContext>;
    },
    unknown,
    RuntimeContext | Scope.Scope
  >;
}

/**
 * `$0` is the daemon, `$1` its input FIFO, `$2` its token. The shell holds
 * the FIFO open for reading and writing, so it never reaches end of file
 * between writers, and says so once it does. `dd count=1` returns what one
 * read gives, so output is forwarded as it arrives.
 */
const SERVE = `rm -f "$1"
mkfifo -m 600 "$1" || exit 1
exec <>"$1"
echo pi-ready
{ sh -c 'echo $$ >"$1.pid"; exec "$0" serve --token "$2"' "$0" "$1" "$2"; rm -f "$1" "$1.pid"; } | while :; do
  chunk=$(dd bs=12288 count=1 2>/dev/null | base64 | tr -d '\\n')
  [ -n "$chunk" ] || break
  printf 'pi:%s\\n' "$chunk"
done`;

/** `$0` is the FIFO, `$1` the bytes in base64. Fails once the daemon is gone. */
const SEND = `[ -p "$0" ] && printf %s "$1" | base64 -d >"$0"`;

/** `$0` is the FIFO. Left alone, the daemon exits 30 seconds after the last byte it was sent. */
const STOP = `[ -f "$0.pid" ] && kill "$(cat "$0.pid")" 2>/dev/null; true`;

/** Bytes per `SEND`: its base64 stays far below the 128 KiB Linux allows one argument. */
const SEND_BYTES = 30 * 1024;

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

const concat = (chunks: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

/**
 * Start the daemon at `daemon` in `sandbox`, with its FIFOs under `dir`.
 * `run` runs an effect on the caller's runtime.
 */
export const openDaemon =
  (
    sandbox: DaemonSandbox,
    paths: { readonly daemon: string; readonly dir: string },
    run: <A, E>(effect: Effect.Effect<A, E, RuntimeContext>) => Promise<A>,
  ): OpenDaemon =>
  async (token, handlers) => {
    const fifo = `${paths.dir}/in.${token}`;
    const scope = Scope.makeUnsafe();
    const process = await run(
      sandbox.start(["sh", "-c", SERVE, paths.daemon, fifo, token]).pipe(Scope.provide(scope)),
    ).catch(async (error: unknown) => {
      await run(Scope.close(scope, Exit.void));
      throw error;
    });

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      void run(
        sandbox
          .exec(["sh", "-c", STOP, fifo], { timeout: "30 seconds" })
          .pipe(
            Effect.ignore,
            Effect.andThen(Effect.ignore(process.kill())),
            Effect.andThen(Scope.close(scope, Exit.void)),
          ),
      );
    };
    /** The daemon ended, or can no longer be reached. */
    const lost = () => {
      close();
      handlers.onClose();
    };

    // Nothing is sent before the script says the FIFO exists.
    let ready = false;
    let sending = false;
    let queue: Array<Uint8Array> = [];
    const send = async () => {
      if (sending || !ready) return;
      sending = true;
      try {
        while (queue.length > 0 && !closed) {
          const bytes = concat(queue);
          queue = [];
          for (let offset = 0; offset < bytes.length && !closed; offset += SEND_BYTES) {
            const chunk = toBase64(bytes.subarray(offset, offset + SEND_BYTES));
            const result = await run(
              sandbox.exec(["sh", "-c", SEND, fifo, chunk], { timeout: "30 seconds" }),
            );
            if (result.exitCode !== 0) throw new Error(`pi-env input exited ${result.exitCode}`);
          }
        }
      } catch {
        lost();
      } finally {
        sending = false;
      }
    };

    const decoder = new TextDecoder();
    let text = "";
    const receive = (data: Uint8Array) => {
      text += decoder.decode(data, { stream: true });
      const lines = text.split("\n");
      text = lines.pop() ?? "";
      for (const line of lines) {
        const encoded = /^pi:([A-Za-z0-9+/=]+)\r?$/.exec(line)?.[1];
        if (encoded !== undefined) handlers.onData(fromBase64(encoded));
        else if (!ready && line.startsWith("pi-ready")) {
          ready = true;
          void send();
        }
      }
    };

    void run(
      process.output.pipe(
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            if (chunk.fd === "stdout") receive(chunk.data);
          }),
        ),
        Effect.ensuring(Effect.sync(lost)),
        Effect.ignore,
      ),
    );

    return {
      write: (bytes) => {
        if (closed) return;
        queue.push(bytes);
        void send();
      },
      close,
    };
  };
