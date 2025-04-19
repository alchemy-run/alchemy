import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Secret } from "../secret";
import type { CloudflareAccountId } from "./account-id";
import { handleApiError } from "./api-error";
/**
 * Authentication options for Cloudflare API
 */
export interface CloudflareAuthOptions {
  /**
   * API Key to use with API Key
   */
  apiKey?: Secret;

  /**
   * API Token to use with API Key
   */
  apiToken?: Secret;

  /**
   * Email to use with API Key
   * If not provided, will attempt to discover from Cloudflare API
   */
  email?: string;
}

export interface CloudflareAccount {
  name: string;
  id: CloudflareAccountId;
  type: "standard" | "zero_rating" | "full_control";
  settings: {
    enforce_twofactor: boolean;
    api_access_enabled: null;
    access_approval_expiry: null;
    abuse_contact_email: null;
  };
  legacy_flags: {
    enterprise_zone_quota: {
      maximum: number;
      current: number;
      available: number;
    };
  };
}

export interface CloudflareUserInfo {
  apiToken?: Secret;
  apiKey?: Secret;
  email: string;
  username: string;
  accounts: CloudflareAccount[];
  organizations: CloudflareOrganization[];
  tokenPermissions: string[] | undefined;
  first_name: string | null;
  last_name: string | null;
  telephone: string | null;
  country: string | null;
  zipcode: string | null;
  two_factor_authentication_enabled: boolean;
  two_factor_authentication_locked: boolean;
  has_pro_zones: boolean;
  has_business_zones: boolean;
  has_enterprise_zones: boolean;
  suspended: boolean;
  betas: string[];
}

export interface CloudflareOrganization {
  id: string;
  name: string;
  status: string;
  permissions: string[];
  roles: string[];
}

const userInfoCache: Record<string, CloudflareUserInfo> = {};

export async function getCloudflareUserInfo(
  options: CloudflareAuthOptions
): Promise<CloudflareUserInfo> {
  const cacheKey = JSON.stringify({
    apiKey: options.apiKey?.unencrypted,
    apiToken: options.apiToken?.unencrypted,
    email: options.email,
  });
  if (userInfoCache[cacheKey]) {
    return userInfoCache[cacheKey];
  }
  const headers = await getCloudflareAuthHeaders(options);
  const user = await fetch("https://api.cloudflare.com/client/v4/user", {
    headers,
  });
  if (!user.ok) {
    if (user.status === 403) {
      throw new Error(
        "Cloudflare authentication required. Did you forget to login with `wrangler login` or set CLOUDFLARE_API_TOKEN, CLOUDFLARE_API_KEY, or CLOUDFLARE_EMAIL, or CLOUDFLARE_API_KEY?"
      );
    }
    await handleApiError(user, "getting", "user", "user");
  }
  const accounts = await fetch(
    "https://api.cloudflare.com/client/v4/accounts",
    {
      headers,
    }
  );
  const userInfo: CloudflareUserInfo = {
    ...((await user.json()) as any).result,
    accounts: ((await accounts.json()) as any).result,
  };
  userInfoCache[cacheKey] = userInfo;
  return userInfo;
}

export async function getCloudflareAuthHeaders(
  options: CloudflareAuthOptions = {}
): Promise<Record<string, string>> {
  // Check for API Token (preferred method)
  const apiToken =
    options.apiToken?.unencrypted ?? process.env.CLOUDFLARE_API_TOKEN;
  if (apiToken) {
    return {
      Authorization: `Bearer ${apiToken}`,
    };
  }

  // Check for API Key
  const apiKey = options.apiKey?.unencrypted ?? process.env.CLOUDFLARE_API_KEY;
  if (apiKey) {
    return {
      "X-Auth-Key": apiKey,
      "X-Auth-Email":
        options.email ??
        process.env.CLOUDFLARE_EMAIL ??
        (await getUserEmailFromApiKey(apiKey)),
    };
  }

  const authConfig = await getRefreshedAuthConfig();
  if (authConfig.oauth_token) {
    return {
      Authorization: `Bearer ${authConfig.oauth_token}`,
    };
  }

  throw new Error(
    "Cloudflare authentication required. Did you forget to login with `wrangler login` or set CLOUDFLARE_API_TOKEN, CLOUDFLARE_API_KEY, or CLOUDFLARE_EMAIL, or CLOUDFLARE_API_KEY?"
  );
}

const emailCache: Record<string, string> = {};

async function getUserEmailFromApiKey(apiKey: string): Promise<string> {
  if (emailCache[apiKey]) {
    return emailCache[apiKey];
  }

  try {
    const baseUrl = "https://api.cloudflare.com/client/v4";

    // Call the /user endpoint to get user information
    const response = await fetch(`${baseUrl}/user`, {
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Key": apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to get user information: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as {
      success: boolean;
      result: {
        id: string;
        email: string;
        name: string;
        [key: string]: any;
      };
    };

    if (!data.success || !data.result || !data.result.email) {
      throw new Error("Cloudflare API did not return valid user information");
    }

    emailCache[apiKey] = data.result.email;
    return data.result.email;
  } catch (error) {
    console.error("Error retrieving email from Cloudflare API:", error);
    throw new Error(
      "Failed to automatically discover email for API Key authentication"
    );
  }
}

async function refreshAuthToken(
  options: WranglerConfig
): Promise<WranglerConfig> {
  const response = await fetch("https://dash.cloudflare.com/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: options.refresh_token!,
      client_id: "54d11594-84e4-41aa-b438-e81b8fa78ee7",
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to refresh auth token: ${response.status} ${response.statusText}`
    );
  }

  const data: any = await response.json();
  if (!data.access_token) {
    throw new Error("Failed to refresh auth token - no access token returned");
  }

  options.oauth_token = data.access_token;
  options.refresh_token = data.refresh_token;
  options.expiration_time = new Date(
    Date.now() + data.expires_in * 1000
  ).toISOString();
  options.scopes = data.scope?.split(" ") || [];

  return options;
}

interface WranglerConfig {
  path: string;
  oauth_token?: string;
  refresh_token?: string;
  expiration_time?: string;
  scopes?: string[];
  /** @deprecated - this field was only provided by the deprecated v1 `wrangler config` command. */
  api_token?: string;
}

async function getRefreshedAuthConfig(): Promise<WranglerConfig> {
  let authConfig = await readWranglerConfig();
  if (authConfig.expiration_time) {
    const expiry = new Date(authConfig.expiration_time);
    // if expiring in 10s
    if (expiry.getTime() < Date.now() + 10 * 1000) {
      authConfig = await refreshAuthToken(authConfig);
      authConfigCache[authConfig.path] = authConfig;
      await writeWranglerConfig(authConfig);
    }
  }
  return authConfig;
}

async function writeWranglerConfig(config: WranglerConfig) {
  const TOML = await import("@iarna/toml");
  const configPath = await findWranglerConfig();
  config = {
    ...config,
  };
  // @ts-ignore - i put this here
  delete config.path;
  const toml = TOML.stringify(config as any);
  await fs.writeFile(configPath, toml);
}

// cache the file once per process
const authConfigCache: Record<string, WranglerConfig> = {};

async function readWranglerConfig(): Promise<WranglerConfig> {
  const configPath = await findWranglerConfig();
  const config = (authConfigCache[configPath] ??= await parseTOML(
    await fs.readFile(configPath, "utf-8")
  ));
  config.path = configPath;
  return config;
}

let wranglerConfigPath: string | undefined;

async function findWranglerConfig(): Promise<string> {
  if (wranglerConfigPath) {
    return wranglerConfigPath;
  }
  const environment = process.env.WRANGLER_API_ENVIRONMENT ?? "production";
  const filePath = path.join(
    "config",
    `${environment === "production" ? "default.toml" : `${environment}.toml`}`
  );

  const xdgAppPaths = (await import("xdg-app-paths")).default;
  //TODO: We should implement a custom path --global-config and/or the WRANGLER_HOME type environment variable
  const configDir = xdgAppPaths(".wrangler").config(); // New XDG compliant config path
  const legacyConfigDir = path.join(os.homedir(), ".wrangler"); // Legacy config in user's home directory

  // Check for the .wrangler directory in root if it is not there then use the XDG compliant path.
  wranglerConfigPath = path.join(
    (await isDirectory(legacyConfigDir)) ? legacyConfigDir : configDir,
    filePath
  );
  return wranglerConfigPath;
}

async function parseTOML(input: string): Promise<any> {
  const TOML = await import("@iarna/toml");
  try {
    // Normalize CRLF to LF to avoid hitting https://github.com/iarna/iarna-toml/issues/33.
    const normalizedInput = input.replace(/\r\n/g, "\n");
    return TOML.parse(normalizedInput);
  } catch (err: any) {
    const { name } = err;
    if (name !== "TomlError") {
      throw err;
    }
    throw new Error("TOML parse error");
  }
}

async function isDirectory(dir: string) {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch (err) {
    return false;
  }
}
