import fs from "node:fs"; // synchronous IO used for thread safety
import os from "node:os";
import path from "node:path";

interface LockState {
  pid: number;
  timestamp: number;
}

const LOCK_DIR = path.join(os.homedir(), ".alchemy", "lock");

export class Lock {
  private path: string;

  constructor(key: string) {
    this.path = path.join(LOCK_DIR, key);
  }

  /**
   * Acquires the lock.
   * @returns True if the lock was acquired successfully, false otherwise.
   */
  acquire(): boolean {
    try {
      fs.mkdirSync(LOCK_DIR, { recursive: true });
      const fd = fs.openSync(this.path, "wx");
      fs.writeSync(
        fd,
        JSON.stringify({ pid: process.pid, timestamp: Date.now() }),
      );
      fs.closeSync(fd);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Releases the lock if it is held by the current process.
   */
  release() {
    const state = this.read();
    if (!state || state.pid !== process.pid) {
      return;
    }
    fs.unlinkSync(this.path);
  }

  /**
   * Returns true if the lock is active.
   */
  check() {
    const state = this.read();
    if (!state) return false;
    return state.timestamp > Date.now() - 1000 * 10;
  }

  /**
   * Waits for the lock to be released.
   */
  async wait(interval = 100) {
    while (true) {
      if (!this.check()) {
        fs.rmSync(this.path, { force: true });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  private read() {
    try {
      const file = fs.readFileSync(this.path, "utf-8");
      return JSON.parse(file) as LockState;
    } catch {
      return undefined;
    }
  }
}
