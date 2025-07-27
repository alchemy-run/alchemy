import { alchemy } from "../alchemy.ts";
import type { Secret } from "../secret.ts";
import type { CloudflareApiOptions } from "./api.ts";
import { getRefreshedWranglerConfig } from "./oauth.ts";
import { getUserEmailFromApiKey } from "./user.ts";

export interface CloudflareApiTokenAuthOptions {
  type: "api-token";
  apiToken: Secret<string>;
}

export interface CloudflareApiKeyAuthOptions {
  type: "api-key";
  apiKey: Secret;
  apiEmail: string;
}

export interface CloudflareWranglerAuthOptions {
  type: "wrangler";
}

export type CloudflareAuthOptions =
  | CloudflareApiTokenAuthOptions
  | CloudflareApiKeyAuthOptions
  | CloudflareWranglerAuthOptions;

export const isCloudflareAuthOptions = (
  input?: CloudflareApiOptions | CloudflareAuthOptions,
): input is CloudflareAuthOptions => {
  return (
    input !== undefined &&
    "type" in input &&
    (input.type === "api-token" ||
      input.type === "api-key" ||
      input.type === "wrangler")
  );
};

export async function normalizeAuthOptions(
  input?: CloudflareApiOptions | CloudflareAuthOptions,
): Promise<CloudflareAuthOptions> {
  if (isCloudflareAuthOptions(input)) {
    return input;
  }

  const email = async (apiKey: Secret<string>) =>
    input?.email ??
    process.env.CLOUDFLARE_EMAIL ??
    (await getUserEmailFromApiKey(apiKey.unencrypted));

  if (input?.apiKey) {
    return {
      type: "api-key",
      apiKey: input.apiKey,
      apiEmail: await email(input.apiKey),
    };
  }
  if (input?.apiToken) {
    return { type: "api-token", apiToken: input.apiToken };
  }
  if (process.env.CLOUDFLARE_API_KEY) {
    const key = alchemy.secret(process.env.CLOUDFLARE_API_KEY);
    return { type: "api-key", apiKey: key, apiEmail: await email(key) };
  }
  if (process.env.CLOUDFLARE_API_TOKEN) {
    return {
      type: "api-token",
      apiToken: alchemy.secret(process.env.CLOUDFLARE_API_TOKEN),
    };
  }
  return { type: "wrangler" };
}

export async function getCloudflareAuthHeaders(
  authOptions: CloudflareAuthOptions,
): Promise<Record<string, string>> {
  switch (authOptions.type) {
    case "api-token":
      return { Authorization: `Bearer ${authOptions.apiToken.unencrypted}` };
    case "api-key":
      return {
        "X-Auth-Key": authOptions.apiKey.unencrypted,
        "X-Auth-Email": authOptions.apiEmail,
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
