import * as Effect from "effect/Effect";

/**
 * Log one line a framework child process wrote as an `output` record: the
 * line as written, with the stream as an annotation. The key matches
 * alchemy's `LogRecord` annotation, so the process that renders logs tags
 * the resource the surrounding lifecycle operation annotated.
 */
export const logChildOutput = (line: string, stream: "stdout" | "stderr") =>
  Effect.logInfo(line).pipe(Effect.annotateLogs({ "alchemy.stream": stream }));

/**
 * Line-buffered {@link logChildOutput} for output that arrives in chunks
 * outside an Effect (Node stream listeners). Logs through the services of
 * the Effect that created it.
 */
export const makeChildOutput = Effect.gen(function* () {
  const context = yield* Effect.context<never>();
  const writer = (stream: "stdout" | "stderr") => {
    let buffer = "";
    const log = (line: string) => Effect.runSyncWith(context)(logChildOutput(line, stream));
    return {
      push(chunk: string) {
        buffer += chunk;
        const lines = buffer.split(/\r\n|\n|\r/);
        buffer = lines.pop() ?? "";
        for (const line of lines) log(line);
      },
      flush() {
        if (buffer !== "") log(buffer);
        buffer = "";
      },
    };
  };
  return { stdout: writer("stdout"), stderr: writer("stderr") };
});
