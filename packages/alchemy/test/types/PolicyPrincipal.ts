import type { PolicyStatement } from "@/AWS/IAM/Policy.ts";

// IAM's grammar takes `"*"` or a principal map for `Principal`/`NotPrincipal`
// (`"*" | <principal_map>`); `"*"` is the only valid bare string.

const _wildcard: PolicyStatement = {
  Effect: "Deny",
  Principal: "*",
  Action: ["s3:*"],
  Condition: { Bool: { "aws:SecureTransport": "false" } },
};

const _notWildcard: PolicyStatement = {
  Effect: "Deny",
  NotPrincipal: "*",
  Action: ["s3:*"],
};

const _map: PolicyStatement = {
  Effect: "Allow",
  Principal: { Service: "cloudfront.amazonaws.com" },
  Action: ["s3:GetObject"],
};

const _bareArn: PolicyStatement = {
  Effect: "Allow",
  // @ts-expect-error A bare principal must be "*"; name one with a principal map.
  Principal: "arn:aws:iam::123456789012:root",
  Action: ["s3:GetObject"],
};
