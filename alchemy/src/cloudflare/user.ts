import type { Secret } from "../secret.ts";
import { logger } from "../util/logger.ts";
import { CloudflareApiError } from "./api-error.ts";
import {
  getCloudflareAuthHeaders,
  type CloudflareAuthOptions,
} from "./auth.ts";

export interface CloudflareAccount {
  name: string;
  id: string;
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

const accountCache: Record<string, CloudflareAccount[]> = {};

export async function getCloudflareAccounts(
  options: CloudflareAuthOptions,
): Promise<CloudflareAccount[]> {
  const cacheKey = JSON.stringify({
    apiKey: options.apiKey?.unencrypted,
    apiToken: options.apiToken?.unencrypted,
    email: options.email,
  });
  if (accountCache[cacheKey]) {
    return accountCache[cacheKey];
  }

  const headers = await getCloudflareAuthHeaders(options);
  const accounts = await fetch(
    "https://api.cloudflare.com/client/v4/accounts",
    {
      headers,
    },
  );

  if (accounts.ok) {
    return (accountCache[cacheKey] ??= ((await accounts.json()) as any).result);
  } else {
    throw new CloudflareApiError(
      `Failed to get accounts for authorized user, please make sure you're authenticated (see: https://alchemy.run/docs/guides/cloudflare-auth.html) or explicitly set the Cloudflare Account ID (see: https://alchemy.run/docs/guides/cloudflare-auth.html#account-id)`,
      accounts,
    );
  }
}

const emailCache: Record<string, string> = {};

export async function getUserEmailFromApiKey(apiKey: string): Promise<string> {
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
        `Failed to get user information: ${response.status} ${response.statusText}`,
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
    logger.error("Error retrieving email from Cloudflare API:", error);
    throw new Error(
      "Failed to automatically discover email for API Key authentication",
    );
  }
}
