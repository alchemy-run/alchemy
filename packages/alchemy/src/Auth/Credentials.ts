import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import path from "pathe";
import { rootDir } from "./Profile.ts";

const credentialsDirPath = path.join(rootDir, "credentials");

export const credentialsFilePath = (profile: string, provider: string) =>
  path.join(credentialsDirPath, profile, `${provider}.json`);

export const readCredentials = Effect.fnUntraced(function* <T>(
  profile: string,
  provider: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const data = yield* fs
    .readFileString(credentialsFilePath(profile, provider))
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  if (data === undefined) return undefined as T | undefined;
  try {
    return JSON.parse(data) as T;
  } catch {
    return undefined as T | undefined;
  }
});

export const writeCredentials = Effect.fnUntraced(function* <T>(
  profile: string,
  provider: string,
  credentials: T,
) {
  const fs = yield* FileSystem.FileSystem;
  const filePath = credentialsFilePath(profile, provider);
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, JSON.stringify(credentials, null, 2));
});

export const deleteCredentials = Effect.fnUntraced(function* (
  profile: string,
  provider: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs
    .remove(credentialsFilePath(profile, provider))
    .pipe(Effect.catch(() => Effect.void));
});

export function displayRedacted(
  r: Redacted.Redacted<string>,
  visibleChars = 4,
): string {
  const raw = Redacted.value(r);
  if (raw.length <= visibleChars) return "****";
  return `${raw.slice(0, visibleChars)}****`;
}
