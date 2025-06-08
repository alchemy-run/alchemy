import { type WriteStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import type { Phase } from "../../alchemy.ts";
import { INGEST_URL, STATE_DIR, TELEMETRY_DISABLED } from "./constants.ts";
import { context } from "./context.ts";
import type { Telemetry } from "./types.ts";

export interface TelemetryClientOptions {
  sessionId: string;
  phase: Phase;
  enabled: boolean;
  quiet: boolean;
}

export interface ITelemetryClient {
  ready: Promise<void>;
  record(event: Telemetry.EventInput): void;
  finalize(): Promise<void>;
}

export class NoopTelemetryClient implements ITelemetryClient {
  ready = Promise.resolve();
  record(_: Telemetry.EventInput) {}
  finalize() {
    return Promise.resolve();
  }
}

export class TelemetryClient implements ITelemetryClient {
  ready: Promise<void>;

  private path: string;
  private promises: Promise<unknown>[] = [];
  private _writeStream?: WriteStream;
  private _context?: Telemetry.Context;

  constructor(readonly options: TelemetryClientOptions) {
    this.path = join(STATE_DIR, `session-${this.options.sessionId}.jsonl`);
    this.ready = this.init();
  }

  private async init() {
    const now = Date.now();
    const [ctx] = await Promise.all([
      context({
        sessionId: this.options.sessionId,
        phase: this.options.phase,
      }),
      this.initFs(),
    ]);
    this._context = ctx;
    this.record(
      {
        event: "app.start",
      },
      now,
    );
  }

  private async initFs() {
    try {
      await mkdir(STATE_DIR, { recursive: true });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        // ignore
      } else {
        throw error;
      }
    }

    const files = await readdir(STATE_DIR);
    this.promises.push(
      ...files
        .filter((file) => file.endsWith(".jsonl"))
        .map((file) => this.flush(join(STATE_DIR, file))),
    );

    this._writeStream = createWriteStream(this.path, { flags: "a" });
  }

  private get context() {
    if (!this._context) {
      throw new Error("Context not initialized");
    }
    return this._context;
  }

  private get writeStream() {
    if (!this._writeStream) {
      throw new Error("Write stream not initialized");
    }
    return this._writeStream;
  }

  record(event: Telemetry.EventInput, timestamp = Date.now()) {
    const payload = {
      ...event,
      error: this.serializeError(event.error),
      context: this.context,
      timestamp,
    } as Telemetry.Event;
    this.writeStream.write(`${JSON.stringify(payload)}\n`);
  }

  private serializeError(
    error: Telemetry.ErrorInput | undefined,
  ): Telemetry.SerializedError | undefined {
    if (!error) {
      return undefined;
    }
    if (error instanceof Error) {
      return {
        ...error, // include additional properties from error object
        name: error.name,
        message: error.message,
        // TODO: maybe redact more of the stack trace?
        stack: error.stack?.replaceAll(os.homedir(), "~"), // redact home directory
      };
    }
    return error;
  }

  async finalize() {
    await new Promise((resolve) => this.writeStream.end(resolve));
    this.promises.push(this.flush(this.path));
    await Promise.allSettled(this.promises).then((results) => {
      for (const result of results) {
        if (result.status === "rejected" && !this.options.quiet) {
          console.warn(result.reason);
        }
      }
    });
  }

  async flush(path: string) {
    const events = await readFile(path, "utf-8").then((file) => {
      const events: Telemetry.Event[] = [];
      for (const line of file.split("\n")) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // ignore
        }
      }
      return events;
    });
    // TODO: deduplicate events on send
    await this.send(events);
    await unlink(path).catch((error) => {
      if (error instanceof Error && error.message.includes("ENOENT")) {
        // ignore
      } else {
        throw error;
      }
    });
  }

  private async send(events: Telemetry.Event[]) {
    if (events.length === 0) {
      return;
    }
    const response = await fetch(INGEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(events),
    });
    if (!response.ok) {
      throw new Error(
        `Failed to send telemetry: ${response.status} ${response.statusText} - ${await response.text()}`,
      );
    }
  }

  static create({
    phase,
    enabled,
    quiet,
  }: Omit<TelemetryClientOptions, "sessionId">): ITelemetryClient {
    if (!enabled || TELEMETRY_DISABLED) {
      if (!quiet) {
        console.warn("[Alchemy] Telemetry is disabled.");
      }
      return new NoopTelemetryClient();
    }
    return new TelemetryClient({
      sessionId: crypto.randomUUID(),
      phase,
      enabled,
      quiet,
    });
  }
}
