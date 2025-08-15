export type AccountId = string & {
  readonly __brand: "AccountId";
};

/**
 * Helper to get the current AWS account ID
 */
export async function AccountId(): Promise<AccountId> {
  const { GetCallerIdentityCommand, STSClient } = await import(
    "@aws-sdk/client-sts"
  ).catch(() => {
    throw new Error(
      "STS client not found. Please add @aws-sdk/client-sts to your project dependencies.",
    );
  });
  const sts = new STSClient({});
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  return identity.Account! as AccountId;
}
