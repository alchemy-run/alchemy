import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface SpawnTeedOptions {
  readonly cmd: string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdin?: string;
  readonly timeoutMs: number;
  /** Kill if no output bytes arrive for this long (hang detection). */
  readonly stallMs?: number;
  readonly transcriptPath: string;
}

export interface SpawnTeedResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stalled: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly wallClockMs: number;
}

/**
 * Spawn a harness process, tee stdout verbatim to the transcript file,
 * enforce a hard wall-clock kill and a no-output stall kill.
 */
export async function spawnTeed(
  options: SpawnTeedOptions,
): Promise<SpawnTeedResult> {
  mkdirSync(dirname(options.transcriptPath), { recursive: true });
  const started = Date.now();
  let timedOut = false;
  let stalled = false;
  let lastOutputAt = Date.now();

  const proc = Bun.spawn(options.cmd, {
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin !== undefined ? Buffer.from(options.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const killTimer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 5_000);
  }, options.timeoutMs);

  const stallTimer = options.stallMs
    ? setInterval(() => {
        if (Date.now() - lastOutputAt > options.stallMs!) {
          stalled = true;
          proc.kill("SIGTERM");
          setTimeout(() => proc.kill("SIGKILL"), 5_000);
        }
      }, 10_000)
    : undefined;

  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const decoder = new TextDecoder();

  const drain = async (
    stream: ReadableStream<Uint8Array>,
    chunks: string[],
    tee: boolean,
  ) => {
    for await (const chunk of stream) {
      lastOutputAt = Date.now();
      const text = decoder.decode(chunk, { stream: true });
      chunks.push(text);
      if (tee) appendFileSync(options.transcriptPath, text);
    }
  };

  await Promise.all([
    drain(proc.stdout, outChunks, true),
    drain(proc.stderr, errChunks, false),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(killTimer);
  if (stallTimer) clearInterval(stallTimer);

  return {
    exitCode,
    timedOut,
    stalled,
    stdout: outChunks.join(""),
    stderr: errChunks.join(""),
    wallClockMs: Date.now() - started,
  };
}

export async function commandVersion(cmd: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim().split("\n")[0] ?? "unknown";
  } catch {
    return "not-installed";
  }
}
