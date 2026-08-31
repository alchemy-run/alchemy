import os from "node:os";
import path from "pathe";

/**
 * Root of alchemy's user-level auth state (`~/.alchemy`). Overridable with
 * `ALCHEMY_HOME`, which relocates the profile manifest, credential files,
 * and cross-process locks together — used by tests to isolate a temp home
 * and available to users who keep dotfiles elsewhere. Resolved lazily so an
 * override set after module load (e.g. in a test) still takes effect.
 */
export const rootDir = () =>
  process.env.ALCHEMY_HOME ?? path.join(os.homedir(), ".alchemy");

export const configFilePath = () => path.join(rootDir(), "profiles.json");

export const credentialsDirPath = () => path.join(rootDir(), "credentials");

export const profileCredentialsDirPath = (profile: string) =>
  path.join(credentialsDirPath(), profile);
