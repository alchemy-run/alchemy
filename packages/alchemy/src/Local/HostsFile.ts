import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";

/**
 * The system hosts file. `alchemy dev --domain <custom>` needs one entry per
 * exposed host there (the file has no wildcards), which requires root — so
 * alchemy never writes it from `dev`; it detects missing entries and prints
 * the `sudo alchemy hosts add …` command for the user to run.
 */
export const HOSTS_FILE =
  process.platform === "win32"
    ? "C:\\Windows\\System32\\drivers\\etc\\hosts"
    : "/etc/hosts";

/** Delimiters of the block alchemy owns inside the hosts file. */
export const BEGIN_MARKER = "# >>> alchemy dev hosts >>>";
export const END_MARKER = "# <<< alchemy dev hosts <<<";

/**
 * Whether `host` resolves to the loopback without a hosts-file entry:
 * `localhost` and every `*.localhost` name do on macOS, on glibc /
 * systemd-resolved Linux, and in every major browser.
 */
export const isNativelyLocal = (host: string): boolean => {
  const lower = host.toLowerCase();
  return lower === "localhost" || lower.endsWith(".localhost");
};

/** Every hostname mapped by any (non-comment) line of a hosts file. */
export const parseHosts = (content: string): Set<string> => {
  const hosts = new Set<string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const [, ...names] = line.split(/\s+/);
    for (const name of names) hosts.add(name.toLowerCase());
  }
  return hosts;
};

/** The hosts inside alchemy's managed block, in file order. */
export const managedHosts = (content: string): string[] => {
  const block = extractBlock(content);
  return block === undefined ? [] : [...parseHosts(block.body)];
};

/** Of `hosts`, those with no mapping anywhere in the hosts file. */
export const missingHosts = (
  content: string,
  hosts: Iterable<string>,
): string[] => {
  const present = parseHosts(content);
  const missing: string[] = [];
  for (const host of hosts) {
    if (!present.has(host.toLowerCase())) missing.push(host);
  }
  return missing;
};

/**
 * Add `hosts` to alchemy's managed block (creating the block at the end of
 * the file when absent). Hosts already in the block are kept once; entries
 * outside the block are never touched. Each host maps to both loopback
 * addresses so `http://host` works whichever family a client prefers.
 */
export const upsertHosts = (
  content: string,
  hosts: Iterable<string>,
): string => {
  const block = extractBlock(content);
  const current = block === undefined ? [] : [...parseHosts(block.body)];
  const merged = new Set(current);
  for (const host of hosts) merged.add(host.toLowerCase());
  return replaceBlock(content, block, [...merged]);
};

/** Remove `hosts` from alchemy's managed block (dropping the block when empty). */
export const removeHosts = (
  content: string,
  hosts: Iterable<string>,
): string => {
  const block = extractBlock(content);
  if (block === undefined) return content;
  const drop = new Set([...hosts].map((h) => h.toLowerCase()));
  const remaining = [...parseHosts(block.body)].filter((h) => !drop.has(h));
  return replaceBlock(content, block, remaining);
};

const renderBlock = (hosts: readonly string[]): string =>
  [
    BEGIN_MARKER,
    ...hosts.flatMap((host) => [`127.0.0.1 ${host}`, `::1 ${host}`]),
    END_MARKER,
  ].join("\n");

interface Block {
  readonly start: number;
  readonly end: number;
  readonly body: string;
}

const extractBlock = (content: string): Block | undefined => {
  const start = content.indexOf(BEGIN_MARKER);
  if (start === -1) return undefined;
  const endMarker = content.indexOf(END_MARKER, start);
  if (endMarker === -1) return undefined;
  const end = endMarker + END_MARKER.length;
  return {
    start,
    end,
    body: content.slice(start + BEGIN_MARKER.length, endMarker),
  };
};

const replaceBlock = (
  content: string,
  block: Block | undefined,
  hosts: readonly string[],
): string => {
  if (block === undefined) {
    if (hosts.length === 0) return content;
    const separator = content === "" || content.endsWith("\n") ? "" : "\n";
    return `${content}${separator}${renderBlock(hosts)}\n`;
  }
  const before = content.slice(0, block.start);
  const after = content.slice(block.end);
  if (hosts.length === 0) {
    // Drop the block and the newline that followed it.
    return `${before}${after.replace(/^\r?\n/, "")}`;
  }
  return `${before}${renderBlock(hosts)}${after}`;
};

/** The command a user runs (with sudo) to map `hosts` to the loopback. */
export const hostsAddCommand = (hosts: readonly string[]): string =>
  `sudo alchemy hosts add ${hosts.join(" ")}`;

/**
 * A CLI-free equivalent of {@link hostsAddCommand} for machines where the
 * `alchemy` binary isn't on root's PATH. Not idempotent (appends plain
 * lines), so it's offered as the fallback.
 */
export const hostsAppendCommand = (hosts: readonly string[]): string =>
  `sudo sh -c 'printf "${hosts
    .flatMap((host) => [`127.0.0.1 ${host}\\n`, `::1 ${host}\\n`])
    .join("")}" >> ${HOSTS_FILE}'`;

export const readHostsFile = (
  file: string = HOSTS_FILE,
): Effect.Effect<string, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file);
  });

export const writeHostsFile = (
  content: string,
  file: string = HOSTS_FILE,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(file, content);
  });
