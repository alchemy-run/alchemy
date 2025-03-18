import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

const sts = new STSClient({});

/**
 * Helper to get the current AWS account ID
 */
export async function getAccountId(): Promise<string> {
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  return identity.Account!;
}
