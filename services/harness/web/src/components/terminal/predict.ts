import type { Terminal } from "@xterm/xterm";

/** How long a guess may wait for the shell's echo before it's withdrawn. */
const CONFIRM_MS = 1500;
/** Wrong guesses in a row before predicting pauses. */
const MAX_MISSES = 2;
/** How long predicting pauses after repeated wrong guesses. */
const PAUSE_MS = 5000;

const PRINTABLE = /^[\x20-\x7e]+$/;
/** Dim + underline: a character the shell hasn't confirmed yet. */
const styled = (text: string) => `\x1b[2;4m${text}\x1b[22;24m`;
/** Move back over `n` cells and blank them, leaving the cursor where they began. */
const rollback = (n: number) => (n > 0 ? `\x1b[${n}D\x1b[${n}X` : "");

/**
 * Predictive local echo, after mosh and VS Code's terminal: characters typed
 * at the end of a line are drawn at once (dimmed and underlined) and
 * reconciled with the shell's echo when it arrives, so typing feels local
 * over any round trip.
 *
 * It only guesses where guessing is safe — the normal screen (not `vim`,
 * `less`), at the end of the line, and only once the shell has echoed a
 * character typed since the last Enter (so a password prompt, which never
 * echoes, never shows a guessed character). It backs off when guesses
 * don't match: an echo that never comes withdraws them, and repeated
 * mismatches pause predicting for a while.
 */
export class PredictiveEcho {
  /** Characters drawn locally that the shell hasn't echoed yet. */
  private pending = "";
  private misses = 0;
  private pausedUntil = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The shell has echoed typing since the last Enter or control key. */
  private echoing = false;
  /** A character sent while not yet `echoing`, whose echo would prove it is. */
  private probe: string | undefined;

  constructor(private readonly term: Terminal) {
    // Switching screens (into `vim`, back out) invalidates any guess.
    term.buffer.onBufferChange(() => this.drop());
  }

  /** The user typed `data` (call it before sending `data` to the shell). */
  input(data: string) {
    if (data === "\x7f" && this.pending.length > 0) {
      // Backspace over a guess: un-draw it.
      this.pending = this.pending.slice(0, -1);
      this.term.write("\x1b[D\x1b[X");
      return;
    }
    if (!PRINTABLE.test(data)) {
      // Enter, a control key, an escape sequence: echo has to prove itself again.
      this.echoing = false;
      this.probe = undefined;
      return;
    }
    if (!this.echoing) {
      this.probe ??= data[0];
      return;
    }
    if (!this.canPredict(data.length)) return;
    this.pending += data;
    this.term.write(styled(data));
    this.armTimer();
  }

  /** The shell sent `data`: returns what to write in its place. */
  output(data: string): string {
    if (this.probe !== undefined && data.startsWith(this.probe)) {
      this.echoing = true;
      this.probe = undefined;
    }
    if (this.pending === "") return data;
    const pending = this.pending;
    let confirmed = 0;
    while (
      confirmed < pending.length &&
      confirmed < data.length &&
      data[confirmed] === pending[confirmed]
    ) {
      confirmed++;
    }
    // The shell said something other than the echo we guessed.
    const mismatch = confirmed < pending.length && data.length > confirmed;
    if (mismatch) {
      this.miss();
      this.echoing = false;
    } else if (confirmed > 0) this.misses = 0;
    const remaining = mismatch ? "" : pending.slice(confirmed);
    this.pending = remaining;
    if (remaining === "") this.clearTimer();
    // Undo every guess, write the truth, then re-draw guesses it hasn't reached.
    return rollback(pending.length) + data + (remaining ? styled(remaining) : "");
  }

  private canPredict(length: number) {
    if (Date.now() < this.pausedUntil) return false;
    const buffer = this.term.buffer.active;
    if (buffer.type !== "normal") return false;
    // Only at the end of the line, and not across the right edge.
    if (buffer.cursorX + length >= this.term.cols - 1) return false;
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    return line !== undefined && line.translateToString(true).length <= buffer.cursorX;
  }

  private miss() {
    this.misses++;
    if (this.misses >= MAX_MISSES) {
      this.misses = 0;
      this.pausedUntil = Date.now() + PAUSE_MS;
    }
  }

  /** Withdraw every guess. */
  private drop() {
    this.clearTimer();
    if (this.pending === "") return;
    const n = this.pending.length;
    this.pending = "";
    this.term.write(rollback(n));
  }

  private armTimer() {
    this.clearTimer();
    this.timer = setTimeout(() => {
      // No echo in time: withdraw, and stop guessing until echo is back.
      this.drop();
      this.miss();
      this.echoing = false;
    }, CONFIRM_MS);
  }

  private clearTimer() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
