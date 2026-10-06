import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { browserProfileDir } from "../../Auth/Paths.ts";
import { resolveProfileName } from "../../Auth/Resolve.ts";
import { login, optionsFromEnv } from "../../GitHub/Browser.ts";
import type { Target } from "../Session.ts";

export interface BrowserLoginTarget extends Target {
  /** GitHub host for GitHub Enterprise Server. @default github.com */
  readonly baseUrl?: string;
}

const resolveProfile = (target: Target) =>
  resolveProfileName(Option.fromNullishOr(target.envFile), target.profile);

/**
 * Sign in to GitHub's web UI and save the session to the browser profile.
 * Unattended with `GITHUB_BROWSER_USERNAME`, `GITHUB_BROWSER_PASSWORD` and
 * `GITHUB_BROWSER_TOTP_SECRET`; otherwise a window opens for the user.
 */
export const browserLogin = Effect.fn(
  "Alchemist.provider.github.browser-login",
)(function* (target: BrowserLoginTarget) {
  const profile = yield* resolveProfile(target);
  const env = yield* optionsFromEnv;
  const result = yield* login({
    profile,
    baseUrl: target.baseUrl,
    headless: env.headless,
    credentials: env.credentials,
  });
  return { profile, ...result };
});

/** Delete the persisted browser profile for the selected Alchemy profile. */
export const browserLogout = Effect.fn(
  "Alchemist.provider.github.browser-logout",
)(function* (target: Target) {
  const profile = yield* resolveProfile(target);
  const fs = yield* FileSystem.FileSystem;
  const profileDir = browserProfileDir(profile);
  const removed = yield* fs.exists(profileDir);
  yield* fs.remove(profileDir, { recursive: true, force: true });
  return { profile, profileDir, removed };
});
