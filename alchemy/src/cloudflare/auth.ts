import type { CloudflareApiOptions } from "./api.ts";
import { getRefreshedWranglerConfig } from "./oauth.ts";
import { getUserEmailFromApiKey } from "./user.ts";

export interface CloudflareApiTokenAuthOptions {
  type: "api-token";
  token: string;
}

export interface CloudflareApiKeyAuthOptions {
  type: "api-key";
  key: string;
  email: string;
}

export interface CloudflareWranglerAuthOptions {
  type: "wrangler";
}

export type CloudflareAuthOptions =
  | CloudflareApiTokenAuthOptions
  | CloudflareApiKeyAuthOptions
  | CloudflareWranglerAuthOptions;

export async function normalizeAuthOptions(
  input?: CloudflareApiOptions,
): Promise<CloudflareAuthOptions> {
  const email = async (apiKey: string) =>
    input?.email ??
    process.env.CLOUDFLARE_EMAIL ??
    (await getUserEmailFromApiKey(apiKey));

  if (input?.apiKey) {
    const key = input.apiKey.unencrypted;
    return { type: "api-key", key, email: await email(key) };
  }
  if (input?.apiToken) {
    return { type: "api-token", token: input.apiToken.unencrypted };
  }
  if (process.env.CLOUDFLARE_API_KEY) {
    const key = process.env.CLOUDFLARE_API_KEY;
    return { type: "api-key", key, email: await email(key) };
  }
  if (process.env.CLOUDFLARE_API_TOKEN) {
    return { type: "api-token", token: process.env.CLOUDFLARE_API_TOKEN };
  }
  return { type: "wrangler" };
}

export async function getCloudflareAuthHeaders(
  authOptions: CloudflareAuthOptions,
): Promise<Record<string, string>> {
  switch (authOptions.type) {
    case "api-token":
      return { Authorization: `Bearer ${authOptions.token}` };
    case "api-key":
      return {
        "X-Auth-Key": authOptions.key,
        "X-Auth-Email": authOptions.email,
      };
    case "wrangler": {
      const wranglerConfig = await getRefreshedWranglerConfig();
      if (wranglerConfig.isErr()) {
        throw new Error(
          [
            wranglerConfig.error.message,
            "Please run `alchemy login`, or set either CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY in your environment.",
            "Learn more: https://alchemy.run/guides/cloudflare/",
          ].join("\n"),
        );
      }
      return {
        Authorization: `Bearer ${wranglerConfig.value.oauth_token}`,
      };
    }
  }
}
