const encoder = new TextEncoder();

export interface TruncatedOutput {
  readonly text: string;
  readonly truncated: boolean;
  readonly totalLines: number;
  readonly shownLines: number;
  readonly totalBytes: number;
}

const byteLength = (text: string): number => encoder.encode(text).byteLength;

const takeBytesFromEnd = (text: string, maxBytes: number): string => {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  return new TextDecoder().decode(bytes.slice(bytes.byteLength - maxBytes));
};

const takeBytesFromStart = (text: string, maxBytes: number): string => {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  return new TextDecoder().decode(bytes.slice(0, maxBytes));
};

/** Keep the beginning — useful for files and search results. */
export const truncateHead = (
  text: string,
  options: { readonly maxLines: number; readonly maxBytes: number },
): TruncatedOutput => {
  const lines = text.split("\n");
  const byLines = lines.slice(0, options.maxLines).join("\n");
  const result = takeBytesFromStart(byLines, options.maxBytes);
  return {
    text: result,
    truncated: result.length < text.length,
    totalLines: lines.length,
    shownLines: result.split("\n").length,
    totalBytes: byteLength(text),
  };
};

/** Keep the end — useful for build and test output. */
export const truncateTail = (
  text: string,
  options: { readonly maxLines: number; readonly maxBytes: number },
): TruncatedOutput => {
  const lines = text.split("\n");
  const byLines = lines.slice(-options.maxLines).join("\n");
  const result = takeBytesFromEnd(byLines, options.maxBytes);
  return {
    text: result,
    truncated: result.length < text.length,
    totalLines: lines.length,
    shownLines: result.split("\n").length,
    totalBytes: byteLength(text),
  };
};

/**
 * Bounded streaming tail collector. It never keeps more than roughly
 * two byte windows in memory; exact line/byte truncation happens at
 * `finish`.
 */
export class TailCollector {
  private value = "";
  private totalBytes = 0;
  private newlineCount = 0;
  private readonly maxBufferBytes: number;
  // an explicit field, NOT a constructor parameter property: the stack
  // program is imported by node in strip-only TS mode, which rejects
  // TS-only runtime syntax (`constructor(private options: …)`)
  private readonly options: {
    readonly maxLines: number;
    readonly maxBytes: number;
  };

  constructor(options: { readonly maxLines: number; readonly maxBytes: number }) {
    this.options = options;
    this.maxBufferBytes = options.maxBytes * 2;
  }

  add(chunk: string): void {
    this.totalBytes += byteLength(chunk);
    this.newlineCount += chunk.split("\n").length - 1;
    this.value += chunk;
    if (byteLength(this.value) > this.maxBufferBytes) {
      this.value = takeBytesFromEnd(this.value, this.maxBufferBytes);
    }
  }

  finish(): TruncatedOutput {
    const result = truncateTail(this.value, this.options);
    const totalLines = this.newlineCount + 1;
    return {
      ...result,
      truncated:
        this.totalBytes > byteLength(result.text) ||
        totalLines > result.shownLines,
      totalBytes: this.totalBytes,
      totalLines,
    };
  }
}

/** Bounded streaming head collector for files and search output. */
export class HeadCollector {
  private value = "";
  private totalBytes = 0;
  private newlineCount = 0;
  // explicit field — see TailCollector on strip-only TS mode
  private readonly options: {
    readonly maxLines: number;
    readonly maxBytes: number;
  };

  constructor(options: { readonly maxLines: number; readonly maxBytes: number }) {
    this.options = options;
  }

  add(chunk: string): void {
    this.totalBytes += byteLength(chunk);
    this.newlineCount += chunk.split("\n").length - 1;
    if (byteLength(this.value) >= this.options.maxBytes) return;
    this.value = takeBytesFromStart(this.value + chunk, this.options.maxBytes);
  }

  finish(): TruncatedOutput {
    const result = truncateHead(this.value, this.options);
    const totalLines = this.newlineCount + 1;
    return {
      ...result,
      truncated:
        this.totalBytes > byteLength(result.text) ||
        totalLines > result.shownLines,
      totalBytes: this.totalBytes,
      totalLines,
    };
  }
}
