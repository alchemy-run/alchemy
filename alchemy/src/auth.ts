import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

namespace Path {
  export const rootDir = path.join(os.homedir(), ".alchemy");
  export const lockDir = path.join(rootDir, "lock");
  export const lockFile = (name: string) => path.join(lockDir, `${name}.lock`);
  export const configFile = path.join(rootDir, "config.json");
  export const credentialsDir = path.join(rootDir, "credentials");
  export const credentialsFile = (provider: string, profile: string) =>
    path.join(credentialsDir, profile, `${provider}.json`);
}

export interface Profile {
  [provider: string]: Provider;
}

export interface Provider<
  Metadata extends Record<string, string> = Record<string, string>,
> {
  metadata: Metadata;
  method: "api-key" | "api-token" | "oauth";
  scopes?: string[];
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
  }
}

interface Props {
  profile: string;
  provider: string;
}

interface AllProfiles {
  [profile: string]: Profile;
}

export const getAllProfiles = async () => {
  const profiles = await FS.readJSON<AllProfiles>(Path.configFile);
  return profiles ?? {};
};

export const getProfile = async (
  name: string,
): Promise<Profile | undefined> => {
  const profiles = await getAllProfiles();
  return profiles[name];
};

export const getProviderCredentials = async <
  Metadata extends Record<string, string> = Record<string, string>,
>(
  props: Props,
) => {
  const [profile, credentials] = await Promise.all([
    getProfile(props.profile),
    FS.readJSON<Credentials>(
      Path.credentialsFile(props.provider, props.profile),
    ),
  ]);
  if (!profile) {
    throw new Error(`Profile "${props.profile}" not found`);
  }
  if (!profile[props.provider]) {
    throw new Error(
      `Provider "${props.provider}" not found in profile "${props.profile}"`,
    );
  }
  if (!credentials) {
    throw new Error(
      `Credentials not found for provider "${props.provider}" and profile "${props.profile}"`,
    );
  }
  return {
    provider: profile[props.provider] as Provider<Metadata>,
    credentials,
  };
};

export const delProviderCredentials = async (props: Props) => {
  const profiles = await getAllProfiles();
  delete profiles[props.profile][props.provider];
  await FS.writeJSON<AllProfiles>(Path.configFile, profiles);
  await fsp.unlink(Path.credentialsFile(props.provider, props.profile));
};

export const getRefreshedCredentials = async (
  props: Props,
  refresh: (credentials: Credentials.OAuth) => Promise<Credentials.OAuth>,
): Promise<Credentials> => {
  const result = await getProviderCredentials(props);
  if (!result) {
    throw new Error("Credentials not found");
  }
  if (!isOAuthCredentialsExpired(result.credentials)) {
    return result.credentials;
  }
  const key = `${props.provider}-${props.profile}`;
  if (await Lock.acquire(key)) {
    try {
      const refreshed = await refresh(result.credentials);
      await setCredentials(props, refreshed);
      return refreshed;
    } finally {
      await Lock.release(key);
    }
  }
  await Lock.wait(key);
  return await getRefreshedCredentials(props, refresh);
};

export const isOAuthCredentialsExpired = (
  credentials: Credentials,
  tolerance = 1000 * 10,
): credentials is Credentials.OAuth => {
  return (
    credentials.type === "oauth" && credentials.expires < Date.now() + tolerance
  );
};

export const setProviderCredentials = async <
  Metadata extends Record<string, string> = Record<string, string>,
>(
  props: Props,
  data: {
    credentials: Credentials;
    provider: Provider<Metadata>;
  },
) => {
  const profiles = await getAllProfiles();
  profiles[props.profile] = {
    ...profiles[props.profile],
    [props.provider]: data.provider,
  };
  await Promise.all([
    FS.writeJSON<AllProfiles>(Path.configFile, profiles),
    setCredentials(props, data.credentials),
  ]);
};

const setCredentials = async (props: Props, credentials: Credentials) => {
  await FS.writeJSON<Credentials>(
    Path.credentialsFile(props.provider, props.profile),
    credentials,
  );
};

namespace FS {
  export const readJSON = async <T>(path: string): Promise<T | undefined> => {
    try {
      const data = await fsp.readFile(path, "utf-8");
      return JSON.parse(data) as T;
    } catch {
      return undefined;
    }
  };

  export const writeJSON = async <T>(name: string, data: T) => {
    await fsp.mkdir(path.dirname(name), { recursive: true });
    await fsp.writeFile(name, JSON.stringify(data, null, 2), { mode: 0o600 });
  };
}

namespace Lock {
  const STALE = 1000 * 10;

  interface File {
    name: string;
    pid: number;
    timestamp: number;
  }

  export const release = async (name: string) => {
    const path = Path.lockFile(name);
    const file = await FS.readJSON<File>(path);
    if (file?.pid === process.pid) {
      await fsp.unlink(path);
    }
  };

  export const acquire = async (name: string): Promise<boolean> => {
    try {
      create(name);
      return true;
    } catch {
      if (await check(name)) {
        return false;
      }
      await fsp.rm(Path.lockFile(name), { force: true });
      return await acquire(name);
    }
  };

  const create = (name: string) => {
    const file: File = {
      name,
      pid: process.pid,
      timestamp: Date.now(),
    };

    fs.mkdirSync(Path.lockDir, { recursive: true });
    const fd = fs.openSync(Path.lockFile(name), "wx");
    fs.writeSync(fd, JSON.stringify(file));
    fs.closeSync(fd);
  };

  const check = async (name: string) => {
    const file = await FS.readJSON<File>(Path.lockFile(name));
    if (!file) return false;
    if (!isPidActive(file.pid)) return false;
    return file.timestamp > Date.now() - STALE;
  };

  export const wait = async (name: string) => {
    while (true) {
      if (await check(name)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      } else {
        return;
      }
    }
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
