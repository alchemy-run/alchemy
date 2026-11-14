/**
 * A minimal POSIX ustar writer: regular files and their parent
 * directories, no compression. Enough for a Docker build context.
 */
export interface TarEntry {
  /** `/`-separated, relative. */
  readonly path: string;
  readonly mode: number;
  readonly bytes: Uint8Array;
}

const BLOCK = 512;
const encoder = new TextEncoder();

const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, "0") + "\0";

const splitPath = (path: string): { name: string; prefix: string } => {
  if (encoder.encode(path).length <= 100) return { name: path, prefix: "" };
  const cut = path.lastIndexOf("/", 155);
  if (cut <= 0 || encoder.encode(path.slice(cut + 1)).length > 100) {
    throw new Error(`path too long for a ustar archive: ${path}`);
  }
  return { name: path.slice(cut + 1), prefix: path.slice(0, cut) };
};

const header = (path: string, mode: number, size: number, type: "0" | "5") => {
  const block = new Uint8Array(BLOCK);
  const write = (offset: number, text: string) => block.set(encoder.encode(text), offset);
  const { name, prefix } = splitPath(path);
  write(0, name);
  write(100, octal(mode & 0o7777, 8));
  write(108, octal(0, 8));
  write(116, octal(0, 8));
  write(124, octal(size, 12));
  write(136, octal(0, 12));
  write(148, "        ");
  write(156, type);
  write(257, "ustar\0");
  write(263, "00");
  write(345, prefix);
  let sum = 0;
  for (const byte of block) sum += byte;
  write(148, octal(sum, 7) + " ");
  return block;
};

/** The archive bytes for `entries`, with a directory entry for every parent. */
export const tar = (entries: ReadonlyArray<TarEntry>): Uint8Array => {
  const parts: Uint8Array[] = [];
  const dirs = new Set<string>();
  for (const entry of entries) {
    const segments = entry.path.split("/").slice(0, -1);
    for (let i = 1; i <= segments.length; i++) {
      const dir = segments.slice(0, i).join("/");
      if (dirs.has(dir)) continue;
      dirs.add(dir);
      parts.push(header(`${dir}/`, 0o755, 0, "5"));
    }
    parts.push(header(entry.path, entry.mode, entry.bytes.length, "0"));
    parts.push(entry.bytes);
    const pad = (BLOCK - (entry.bytes.length % BLOCK)) % BLOCK;
    if (pad > 0) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
