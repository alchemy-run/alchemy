import * as Effect from "effect/Effect";
import { toBase64 } from "../Util/bytes.ts";
import { Workspace } from "../Workspace/Workspace.ts";
// build-stamp: pty long-poll v2

/**
 * The GUEST-SIDE PTY surface — the flat RPC methods a sandbox guest
 * (the MicroVM's in-VM Bun server) serves so an operator terminal can
 * attach a REAL interactive shell to the session's machine. Flat by
 * design: the fetch-RPC dispatcher (`serveRpc`) resolves methods by
 * name, so the nested `Sandbox.pty` group is flattened onto the wire
 * as `pty*` methods.
 *
 * The output leg is a LONG-POLL (`ptyRead`), not a streaming response:
 * ingress proxies between the caller and the guest (the MicroVM
 * endpoint proxy, its local emulation) are entitled to fully buffer a
 * response body, which holds an infinite stream's bytes hostage until
 * EOF. A long-poll response is finite — it ends the moment output
 * exists (or after `waitMs` of silence) — so every proxy forwards it.
 * Interactivity is preserved because a keystroke's echo ENDS the
 * in-flight poll immediately.
 */
export interface SandboxPtyRpc {
  /**
   * Ensure a PTY named `id` exists: spawn a login shell on first open
   * — in `cwd` (workspace-relative) when given, else the workspace
   * root; an existing PTY just adopts the caller's dimensions
   * (reattach after a client reconnect).
   */
  readonly ptyOpen: (
    id: string,
    cols: number,
    rows: number,
    cwd?: string,
  ) => Effect.Effect<void, string>;
  /**
   * Long-poll the PTY's output from `fromSeq`: returns immediately
   * with everything retained at-or-after the cursor (base64 chunks),
   * or holds up to `waitMs` for the next output. `fromSeq: 0` replays
   * the retained ring (repaint after reconnect). `done: true` means
   * the PTY is gone (shell exited or machine recycled) and the caller
   * had a live cursor — poll no further.
   */
  readonly ptyRead: (
    id: string,
    fromSeq: number,
    waitMs: number,
  ) => Effect.Effect<PtyReadResult, string>;
  /** Write keystrokes (UTF-8 text, escape sequences included). */
  readonly ptyInput: (id: string, data: string) => Effect.Effect<void, string>;
  readonly ptyResize: (
    id: string,
    cols: number,
    rows: number,
  ) => Effect.Effect<void, string>;
  /** Kill the shell and drop the PTY (ends every attached poll). */
  readonly ptyClose: (id: string) => Effect.Effect<void, string>;
}

/** One `ptyRead` answer: base64 output chunks and the next cursor. */
export interface PtyReadResult {
  /** Output chunks (base64-encoded bytes), oldest first. */
  readonly b64: ReadonlyArray<string>;
  /** The cursor to pass to the next `ptyRead`. */
  readonly nextSeq: number;
  /** The PTY is gone — stop polling (reopen to respawn). */
  readonly done: boolean;
}

// Structural types for the slice of `Bun.Terminal` this module uses —
// the guest declares `runtime: "bun"`, but this package compiles
// without Bun's ambient types.
interface BunTerminal {
  write(data: string | Uint8Array): number;
  resize(cols: number, rows: number): void;
  close(): void;
  readonly closed: boolean;
}

interface BunPtySubprocess {
  readonly terminal: BunTerminal;
  readonly exited: Promise<number>;
  readonly pid: number;
  kill(signal?: number): void;
}

interface BunWithTerminal {
  Terminal?: unknown;
  spawn(
    cmd: string[],
    options: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      terminal: {
        cols: number;
        rows: number;
        data: (terminal: BunTerminal, chunk: Uint8Array | string) => void;
      };
    },
  ): BunPtySubprocess;
}

interface RingChunk {
  readonly seq: number;
  readonly bytes: Uint8Array;
}

interface PtyEntry {
  readonly proc: BunPtySubprocess;
  /** Newest-retained output for reattach repaint, oldest first. */
  ring: RingChunk[];
  ringBytes: number;
  /** Sequence number the NEXT pushed chunk will carry. */
  seq: number;
  /** Long-polls parked until the next push (each is one-shot). */
  readonly waiters: Set<() => void>;
}

/** Retained output per PTY — enough to repaint a screenful of history
 *  on reattach without holding a whole session's scrollback. */
const RING_CAP_BYTES = 64 * 1024;

/** Hard ceiling on a single long-poll hold. Kept under common proxy
 *  and server idle-reap windows (Bun's own default is 10s). */
const MAX_WAIT_MS = 8_000;

const encoder = new TextEncoder();

/** The user's own login shell when the host declares one (the dev
 *  sandbox IS the developer's machine — their zsh/fish, their rc
 *  files); else a login bash if the image has it; else the POSIX
 *  shell. A `$SHELL` that is itself plain `sh` yields to bash. Either
 *  way the PTY holds a real interactive shell. */
const SHELL_COMMAND = [
  "/bin/sh",
  "-lc",
  [
    'case "${SHELL##*/}" in ""|sh|dash) ;; *) [ -x "$SHELL" ] && exec "$SHELL" -l ;; esac',
    "command -v bash >/dev/null 2>&1 && exec bash -l",
    "exec sh -l",
  ].join("; "),
];

/**
 * Build the guest PTY registry over `Bun.Terminal` (Bun >= 1.3.5) —
 * the native PTY the guest runtime already ships, so no addon is
 * baked into the image. PTYs OUTLIVE their subscribers by design: a
 * dropped WebSocket (or a hibernated Durable Object) just stops
 * polling, and the next `ptyRead(0)` replays the ring buffer and
 * resumes — the shell never notices.
 */
export const makeSandboxPty: Effect.Effect<SandboxPtyRpc, never, Workspace> =
  Effect.gen(function* () {
    const workspace = yield* Workspace;
    const ptys = new Map<string, PtyEntry>();

    const bun = (globalThis as { Bun?: BunWithTerminal }).Bun;
    const unavailable =
      bun === undefined
        ? "PTY requires the Bun runtime (this guest is not running under Bun)"
        : bun.Terminal === undefined
          ? "PTY requires Bun >= 1.3.5 (Bun.Terminal is missing — rebuild the sandbox image to pick up a newer Bun)"
          : undefined;

    const push = (entry: PtyEntry, chunk: Uint8Array) => {
      entry.ring.push({ seq: entry.seq++, bytes: chunk });
      entry.ringBytes += chunk.byteLength;
      while (entry.ringBytes > RING_CAP_BYTES && entry.ring.length > 1) {
        entry.ringBytes -= entry.ring[0]!.bytes.byteLength;
        entry.ring.shift();
      }
      // wake every parked long-poll (each waiter is one-shot and
      // removes itself from the set when it runs)
      for (const wake of [...entry.waiters]) wake();
    };

    const spawn = (id: string, cols: number, rows: number, cwd: string) => {
      const entry: PtyEntry = {
        // assigned below — Bun.spawn is synchronous, and the data
        // callback only fires after this tick
        proc: undefined as never,
        ring: [],
        ringBytes: 0,
        seq: 0,
        waiters: new Set(),
      };
      const proc = bun!.spawn(SHELL_COMMAND, {
        cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          // macOS's /bin/bash 3.2 greets every interactive start with a
          // "default shell is now zsh" notice — moot in a sandbox
          BASH_SILENCE_DEPRECATION_WARNING: "1",
        },
        terminal: {
          cols,
          rows,
          data: (_terminal, chunk) => {
            // copy: Bun may reuse the underlying buffer across callbacks
            push(
              entry,
              typeof chunk === "string" ? encoder.encode(chunk) : chunk.slice(),
            );
          },
        },
      });
      (entry as { proc: BunPtySubprocess }).proc = proc;
      proc.exited.then(
        (code) => {
          // a respawn may have replaced this entry — only reap ourselves
          if (ptys.get(id) !== entry) return;
          push(entry, encoder.encode(`\r\n[shell exited (${code})]\r\n`));
          ptys.delete(id);
          // wake the polls parked on the (now removed) entry so they
          // deliver the exit message instead of timing out
          for (const wake of [...entry.waiters]) wake();
          try {
            proc.terminal.close();
          } catch {
            // already closed
          }
        },
        () => {},
      );
      return entry;
    };

    const withPty = <A>(
      id: string,
      use: (entry: PtyEntry) => A,
    ): Effect.Effect<A, string> =>
      Effect.suspend(() => {
        const entry = ptys.get(id);
        if (entry === undefined) {
          return Effect.fail(`no pty '${id}' — open it first`);
        }
        return Effect.try({
          try: () => use(entry),
          catch: (cause) => `pty '${id}': ${String(cause)}`,
        });
      });

    const ptyOpen = Effect.fn(function* (
      id: string,
      cols: number,
      rows: number,
      cwd?: string,
    ) {
      if (unavailable !== undefined) return yield* Effect.fail(unavailable);
      const existing = ptys.get(id);
      if (existing !== undefined) {
        // Reattach: adopt the caller's dimensions, keep the shell — and
        // force a repaint. The replayed ring is a byte tail, not a screen
        // snapshot: a full-screen TUI (alternate screen, cursor-addressed
        // draws) renders corrupted from it. SIGWINCH makes the app redraw
        // from its own model, but the kernel only delivers it on an ACTUAL
        // size change — so jiggle through an off-by-one size first.
        yield* withPty(id, (entry) => {
          entry.proc.terminal.resize(cols, Math.max(1, rows - 1));
          entry.proc.terminal.resize(cols, rows);
        });
        return;
      }
      // an omitted cwd arrives as `null` over JSON RPC — same as absent
      const dir =
        cwd == null || cwd === "."
          ? yield* workspace.root
          : yield* workspace.resolveExisting(cwd);
      const spawned = yield* Effect.try({
        try: () => spawn(id, cols, rows, dir),
        catch: (cause) => `failed to spawn pty '${id}': ${String(cause)}`,
      });
      ptys.set(id, spawned);
    });

    const collect = (entry: PtyEntry, fromSeq: number): PtyReadResult => ({
      b64: entry.ring
        .filter((chunk) => chunk.seq >= fromSeq)
        .map((chunk) => toBase64(chunk.bytes)),
      nextSeq: entry.seq,
      done: false,
    });

    const ptyRead = (
      id: string,
      fromSeq: number,
      waitMs: number,
    ): Effect.Effect<PtyReadResult, string> =>
      Effect.suspend(() => {
        const entry = ptys.get(id);
        if (entry === undefined) {
          // a live cursor means the shell existed and is now gone (exit,
          // recycle) — tell the poller to stop; a zero cursor is a
          // caller that skipped `open`
          return fromSeq > 0
            ? Effect.succeed({ b64: [], nextSeq: fromSeq, done: true })
            : Effect.fail(`no pty '${id}' — open it first`);
        }
        if (entry.seq > fromSeq) {
          return Effect.succeed(collect(entry, fromSeq));
        }
        // nothing new: park until the next push, the shell's exit, or
        // the wait ceiling — whichever ends the poll first
        return Effect.callback<PtyReadResult, string>((resume, signal) => {
          let settled = false;
          const wake = () => {
            if (settled) return;
            settled = true;
            entry.waiters.delete(wake);
            clearTimeout(timer);
            const live = ptys.get(id);
            resume(
              Effect.succeed(
                live === entry
                  ? collect(entry, fromSeq)
                  : // exited mid-poll: the exit message is in the ring
                    { ...collect(entry, fromSeq), done: true },
              ),
            );
          };
          const timer = setTimeout(wake, Math.min(waitMs, MAX_WAIT_MS));
          entry.waiters.add(wake);
          signal.addEventListener("abort", () => {
            settled = true;
            entry.waiters.delete(wake);
            clearTimeout(timer);
          });
        });
      });

    const ptyInput = (id: string, data: string) =>
      withPty(id, (entry) => {
        entry.proc.terminal.write(data);
      });

    const ptyResize = (id: string, cols: number, rows: number) =>
      withPty(id, (entry) => entry.proc.terminal.resize(cols, rows));

    const ptyClose = (id: string) =>
      withPty(id, (entry) => {
        ptys.delete(id);
        for (const wake of [...entry.waiters]) wake();
        try {
          entry.proc.kill();
        } catch {
          // already dead
        }
        try {
          entry.proc.terminal.close();
        } catch {
          // already closed
        }
      });

    return { ptyOpen, ptyRead, ptyInput, ptyResize, ptyClose };
  });
