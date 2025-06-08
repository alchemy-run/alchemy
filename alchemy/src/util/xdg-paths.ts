import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Vendored XDG Base Directory Specification implementation
 * Provides cross-platform directory paths for config and state
 */
export function createXdgAppPaths(appName: string) {
  const platform = process.platform;
  const home = homedir();

  function config(): string {
    if (platform === "win32") {
      return join(
        process.env.LOCALAPPDATA || join(home, "AppData", "Local"),
        appName,
      );
    } else if (platform === "darwin") {
      return join(home, "Library", "Preferences", appName);
    } else {
      // Linux/Unix - follow XDG Base Directory Specification
      const xdgConfigHome =
        process.env.XDG_CONFIG_HOME || join(home, ".config");
      return join(xdgConfigHome, appName);
    }
  }

  function state(): string {
    if (platform === "win32") {
      return join(
        process.env.LOCALAPPDATA || join(home, "AppData", "Local"),
        appName,
      );
    } else if (platform === "darwin") {
      return join(home, "Library", "Application Support", appName);
    } else {
      // Linux/Unix - follow XDG Base Directory Specification
      const xdgStateHome =
        process.env.XDG_STATE_HOME || join(home, ".local", "state");
      return join(xdgStateHome, appName);
    }
  }

  return {
    config,
    state,
  };
}
