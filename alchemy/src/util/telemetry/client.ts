import {
  type WriteStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Phase } from "../../alchemy.ts";
import { INGEST_URL, STATE_DIR, TELEMETRY_DISABLED } from "./constants.ts";
import { context } from "./context.ts";
import type { Telemetry } from "./types.ts";

export interface TelemetryClientOptions {
  phase: Phase;
  enabled: boolean;
  quiet: boolean;
}

export interface ITelemetryClient {
  record(event: Telemetry.EventInput): void;
  finalize(): Promise<void>;
}

export class NoopTelemetryClient implements ITelemetryClient {
  record(_: Telemetry.EventInput) {}
  finalize() {
    return Promise.resolve();
  }
}

export class TelemetryClient implements ITelemetryClient {
  private path: string;
  private writeStream: WriteStream;
  private promises: Promise<unknown>[];

  constructor(readonly context: Telemetry.Context) {
    if (!existsSync(STATE_DIR)) {
      mkdirSync(STATE_DIR, { recursive: true });
    }

    const files = readdirSync(STATE_DIR);
    this.promises = files.map((file) => this.flush(join(STATE_DIR, file)));

    this.path = join(STATE_DIR, `session-${this.context.sessionId}.jsonl`);
    this.writeStream = createWriteStream(this.path, { flags: "a" });
  }

  record(event: Telemetry.EventInput) {
    const payload = {
      ...event,
      error: this.serializeError(event.error),
      context: this.context,
      timestamp: Date.now(),
    } as Telemetry.Event;
    this.writeStream?.write(`${JSON.stringify(payload)}\n`);
  }

  private serializeError(
    error: Telemetry.ErrorInput | undefined,
  ): Telemetry.SerializedError | undefined {
    if (!error) {
      return undefined;
    }
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }
    return error;
  }

  async finalize() {
    await new Promise((resolve) => this.writeStream.end(resolve));
    this.promises.push(this.flush(this.path));
    await Promise.allSettled(this.promises).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          console.warn(result.reason);
        }
      }
    });
  }

  async flush(path: string) {
    const events = await readFile(path, "utf-8").then((file) => {
      const events: Telemetry.Event[] = [];
      for (const line of file.split("\n")) {
        if (line) {
          events.push(JSON.parse(line));
        }
      }
      return events;
    });
    await this.send(events);
    await unlink(path);
  }

  private async send(events: Telemetry.Event[]) {
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

  static async create({
    phase,
    enabled,
    quiet,
  }: TelemetryClientOptions): Promise<ITelemetryClient> {
    if (!enabled || TELEMETRY_DISABLED) {
      if (!quiet) {
        console.warn("[Alchemy] Telemetry is disabled.");
      }
      return new NoopTelemetryClient();
    }
    return new TelemetryClient(
      await context({
        sessionId: crypto.randomUUID(),
        phase,
      }),
    );
  }
}
