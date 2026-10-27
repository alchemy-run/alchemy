/**
 * Buffers arbitrary text chunks and emits complete lines. Call `flush` when
 * the source closes to emit a trailing partial line.
 *
 * Only the new chunk is scanned for line breaks, and a partial line is kept
 * as a list of pieces joined once it completes, so a long line arriving in
 * many chunks costs linear time and memory (re-splitting the whole pending
 * line on every chunk was quadratic).
 */
export const makeLineBuffer = (onLine: (line: string) => void) => {
  let pieces: string[] = [];
  // A chunk ended in `\r`; a `\n` opening the next one belongs to it.
  let afterCarriageReturn = false;
  const emit = (last: string) => {
    pieces.push(last);
    const line = pieces.join("");
    pieces = [];
    onLine(line);
  };
  return {
    push(chunk: string) {
      let start = 0;
      if (afterCarriageReturn && chunk.startsWith("\n")) start = 1;
      afterCarriageReturn = false;
      for (let i = start; i < chunk.length; i++) {
        const char = chunk[i];
        if (char !== "\n" && char !== "\r") continue;
        emit(chunk.slice(start, i));
        if (char === "\r") {
          if (i + 1 === chunk.length) afterCarriageReturn = true;
          else if (chunk[i + 1] === "\n") i++;
        }
        start = i + 1;
      }
      if (start < chunk.length) pieces.push(chunk.slice(start));
    },
    flush() {
      afterCarriageReturn = false;
      if (pieces.length === 0) return;
      emit("");
    },
  };
};
