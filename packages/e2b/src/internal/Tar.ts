/**
 * The gzipped tar a template build's `COPY` step uploads: the step's files
 * at their archive paths, as E2B's builder extracts them.
 */
import * as zlib from "node:zlib";
import * as Effect from "effect/Effect";

export interface TarFile {
  /** Path inside the archive, `/`-separated. */
  readonly path: string;
  readonly mode: number;
  readonly contents: Uint8Array;
}

const encoder = new TextEncoder();

// ---- tar (ustar + pax for long names) ---------------------------------------

const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, "0") + "\0";

const header = (name: string, size: number, mode: number, type: "0" | "x"): Uint8Array => {
  const block = new Uint8Array(512);
  const write = (text: string, offset: number) => block.set(encoder.encode(text), offset);
  write(name.slice(0, 100), 0);
  write(octal(mode, 8), 100);
  write(octal(0, 8), 108);
  write(octal(0, 8), 116);
  write(octal(size, 12), 124);
  write(octal(0, 12), 136);
  write("        ", 148);
  write(type, 156);
  write("ustar\0", 257);
  write("00", 263);
  let checksum = 0;
  for (const byte of block) checksum += byte;
  write(octal(checksum, 7) + " ", 148);
  return block;
};

const padded = (bytes: Uint8Array): Uint8Array[] => {
  const pad = (512 - (bytes.length % 512)) % 512;
  return pad === 0 ? [bytes] : [bytes, new Uint8Array(pad)];
};

const paxRecord = (key: string, value: string) => {
  // "<len> <key>=<value>\n", where <len> counts itself.
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (String(length).length + body.length !== length)
    length = String(length).length + body.length;
  return `${length}${body}`;
};

/** A gzipped tar of the files, as E2B's builder extracts it. */
export const tarGzip = (files: ReadonlyArray<TarFile>) =>
  Effect.sync(() => {
    const parts: Uint8Array[] = [];
    for (const file of files) {
      if (encoder.encode(file.path).length > 100) {
        const pax = encoder.encode(paxRecord("path", file.path));
        parts.push(header("PaxHeader", pax.length, 0o644, "x"), ...padded(pax));
      }
      parts.push(header(file.path, file.contents.length, file.mode, "0"), ...padded(file.contents));
    }
    parts.push(new Uint8Array(1024));
    const size = parts.reduce((n, p) => n + p.length, 0);
    const tar = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      tar.set(part, offset);
      offset += part.length;
    }
    return new Uint8Array(zlib.gzipSync(tar));
  });
