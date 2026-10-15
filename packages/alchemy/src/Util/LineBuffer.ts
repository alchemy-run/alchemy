/**
 * Buffers arbitrary text chunks and emits complete lines. Call `flush` when
 * the source closes to emit a trailing partial line.
 */
export const makeLineBuffer = (onLine: (line: string) => void) => {
  let buffer = "";
  let skipLF = false;
  return {
    push(chunk: string) {
      if (chunk === "") return;
      if (skipLF && chunk.startsWith("\n")) chunk = chunk.slice(1);
      skipLF = chunk.endsWith("\r");
      buffer += chunk;
      const lines = buffer.split(/\r\n|\n|\r/);
      buffer = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    },
    flush() {
      skipLF = false;
      if (buffer === "") return;
      onLine(buffer);
      buffer = "";
    },
  };
};
