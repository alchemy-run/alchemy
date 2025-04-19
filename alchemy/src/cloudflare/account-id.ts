import { getCloudflareUserInfo, type CloudflareAuthOptions } from "./auth";

export type CloudflareAccountId = string & {
  readonly __brand: "CloudflareAccountId";
};

export async function CloudflareAccountId(
  options: CloudflareAuthOptions
): Promise<CloudflareAccountId> {
  const userInfo = await getCloudflareUserInfo(options);
  return userInfo.accounts[0].id as CloudflareAccountId;
}
