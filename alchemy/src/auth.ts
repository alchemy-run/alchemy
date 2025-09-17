import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { singleFlight } from "./util/memoize.ts";

namespace Path {
  export const rootDir = path.join(os.homedir(), ".alchemy");
  export const lockDir = path.join(rootDir, "lock");
  export const lockFile = (name: string) => path.join(lockDir, `${name}.lock`);
  export const configFile = path.join(rootDir, "config.json");
  export const credentialsDir = path.join(rootDir, "credentials");
  export const credentialsFile = (provider: string, profile: string) =>
    path.join(credentialsDir, profile, `${provider}.json`);
}

interface Props {
  profile: string;
  provider: string;
}

interface Config {
  version: 1;
  profiles: {
    [profile: string]: Profile;
  };
}

namespace Config {
  export const read = async () => {
    const config = await FS.readJSON<Config>(Path.configFile);
    return config ?? { version: 1, profiles: {} };
  };

  export const patch = async (updater: (config: Config) => Config) => {
    const config = await read();
    const updated = updater(config);
    await FS.writeJSON<Config>(Path.configFile, updated);
  };
}

export interface Profile {
  [provider: string]: Provider;
}

export namespace Profile {
  export const get = async (name: string): Promise<Profile | undefined> => {
    const config = await Config.read();
    return config.profiles[name];
  };
}

export interface Provider<
  Metadata extends Record<string, string> = Record<string, string>,
> {
  metadata: Metadata;
  method: "api-key" | "api-token" | "oauth";
  scopes?: string[];
}

export namespace Provider {
  export const get = async <
    Metadata extends Record<string, string> = Record<string, string>,
  >(
    props: Props,
  ) => {
    const profile = await Profile.get(props.profile);
    return profile?.[props.provider] as Provider<Metadata> | undefined;
  };

  export const getWithCredentials = async <
    Metadata extends Record<string, string> = Record<string, string>,
  >(
    props: Props,
  ) => {
    const [provider, credentials] = await Promise.all([
      Provider.get<Metadata>(props),
      Credentials.get(props),
    ]);
    if (!provider) {
      throw new Error(
        `Provider "${props.provider}" not found in profile "${props.profile}". Please run \`alchemy configure -p ${props.profile}\` to configure this provider.`,
      );
    }
    if (!credentials) {
      throw new Error(
        `Credentials not found for provider "${props.provider}" and profile "${props.profile}". Please run \`alchemy login ${props.provider}\` to login to this provider.`,
      );
    }
    return { provider, credentials };
  };

  export const set = async <
    Metadata extends Record<string, string> = Record<string, string>,
  >(
    props: Props,
    provider: Provider<Metadata>,
  ) => {
    await Config.patch((config) => {
      config.profiles[props.profile] ??= {};
      config.profiles[props.profile][props.provider] = provider;
      return config;
    });
  };

  export const del = async (props: Props) => {
    await Config.patch((config) => {
      if (config.profiles[props.profile]) {
        delete config.profiles[props.profile][props.provider];
      }
      if (Object.keys(config.profiles[props.profile]).length === 0) {
        delete config.profiles[props.profile];
      }
      return config;
    });
  };
}

export type Credentials =
  | Credentials.ApiKey
  | Credentials.ApiToken
  | Credentials.OAuth;

export namespace Credentials {
  export interface ApiKey {
    type: "api-key";
    apiKey: string;
    email: string;
  }

  export interface ApiToken {
    type: "api-token";
    apiToken: string;
  }

  export interface OAuth {
    type: "oauth";
    access: string;
    refresh: string;
    expires: number;
    scopes: string[];
  }

  /**
   * Gets the credentials file.
   * @param props The profile and provider of the credentials.
   */
  export const get = async (props: Props) => {
    return await FS.readJSON<Credentials>(
      Path.credentialsFile(props.provider, props.profile),
    );
  };

  /**
   * Sets the credentials file.
   * @param props The profile and provider of the credentials.
   * @param credentials The credentials to set.
   */
  export const set = async (props: Props, credentials: Credentials) => {
    await FS.writeJSON<Credentials>(
      Path.credentialsFile(props.provider, props.profile),
      credentials,
    );
  };

  /**
   * Deletes the credentials file.
   * @param props The profile and provider of the credentials.
   */
  export const del = async (props: Props) => {
    await fs.unlink(Path.credentialsFile(props.provider, props.profile));
  };

  /**
   * Gets refreshed OAuth credentials.
   * Uses `singleFlight` and `Lock` to avoid making multiple concurrent requests to refresh credentials.
   * @param props The properties of the credentials.
   * @param refresh The function to refresh the credentials.
   * @returns The refreshed credentials.
   */
  export const getRefreshed = singleFlight(
    async (
      props: Props,
      refresh: (credentials: Credentials.OAuth) => Promise<Credentials.OAuth>,
    ): Promise<Credentials> => {
      const credentials = await Credentials.get(props);
      if (!credentials) {
        throw new Error(
          `Credentials for provider "${props.provider}" not found in profile "${props.profile}"`,
        );
      }
      if (!Credentials.isOAuthExpired(credentials)) {
        return credentials;
      }
      const key = `${props.provider}-${props.profile}`;
      if (await Lock.acquire(key)) {
        try {
          const refreshed = await refresh(credentials);
          await Credentials.set(props, refreshed);
          return refreshed;
        } finally {
          await Lock.release(key);
        }
      }
      await Lock.wait(key);
      return await Credentials.getRefreshed(props, refresh);
    },
    (props) => `${props.provider}:${props.profile}`,
  );

  /**
   * Returns true if the given credentials are OAuth and expired.
   */
  export const isOAuthExpired = (
    credentials: Credentials,
    tolerance = 1000 * 10,
  ): credentials is Credentials.OAuth => {
    return (
      credentials.type === "oauth" &&
      credentials.expires < Date.now() + tolerance
    );
  };
}

namespace FS {
  export const readJSON = async <T>(path: string): Promise<T | undefined> => {
    try {
      const data = await fs.readFile(path, "utf-8");
      return JSON.parse(data) as T;
    } catch {
      return undefined;
    }
  };

  export const writeJSON = async <T>(name: string, data: T) => {
    await fs.mkdir(path.dirname(name), { recursive: true });
    await fs.writeFile(name, JSON.stringify(data, null, 2), { mode: 0o600 });
  };
}

namespace Lock {
  const STALE = 1000 * 10;

  interface File {
    name: string;
    pid: number;
    timestamp: number;
  }

  /**
   * Acquires a lock on a resource.
   *
   * WARNING: This function uses async io, so it is not thread-safe within a single process.
   * Use a `singleFlight` or mutex to ensure thread-safety.
   *
   * @param name The name of the resource to lock.
   * @returns True if the lock was acquired, false if it was already held by another process.
   */
  export const acquire = async (name: string): Promise<boolean> => {
    try {
      await create(name);
      return true;
    } catch {
      if (await check(name)) {
        return false;
      }
      await fs.rm(Path.lockFile(name), { force: true });
      return await acquire(name);
    }
  };

  /**
   * Releases a lock on a resource if the lock is held by the current process.
   * @param name The name of the resource to release.
   */
  export const release = async (name: string) => {
    const path = Path.lockFile(name);
    const file = await FS.readJSON<File>(path);
    if (file?.pid === process.pid) {
      await fs.unlink(path);
    }
  };

  /**
   * Waits for a lock on a resource to be released.
   * @param name The name of the resource to wait for.
   */
  export const wait = async (name: string) => {
    while (true) {
      if (await check(name)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      } else {
        return;
      }
    }
  };

  const create = async (name: string) => {
    const content: File = {
      name,
      pid: process.pid,
      timestamp: Date.now(),
    };

    await fs.mkdir(Path.lockDir, { recursive: true });
    const file = await fs.open(Path.lockFile(name), "wx");
    await file.write(JSON.stringify(content));
    await file.close();
  };

  const check = async (name: string) => {
    const file = await FS.readJSON<File>(Path.lockFile(name));
    if (!file) return false;
    if (!isPidActive(file.pid)) return false;
    return Date.now() > file.timestamp + STALE;
  };

  const isPidActive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
}
