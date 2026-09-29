import type { PolicyStatement } from "@/AWS/IAM/Policy.ts";

// IAM's grammar takes a bare string (`"*"`) or a principal map for
// `Principal`/`NotPrincipal` (`"*" | <principal_map>`).

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
