import { secretArnOf } from "@alchemy.run/aws/ECS/Service";
import { describe, expect, it } from "@alchemy.run/test";

const secretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:app/db-AbCdEf";

describe("secretArnOf", { tags: ["unit", "provider:aws", "provider:aws:ecs", "local"] }, () => {
  it("keeps a whole-secret ARN", () => {
    expect(secretArnOf(secretArn)).toBe(secretArn);
  });

  it("strips a JSON key reference to the secret's ARN", () => {
    expect(secretArnOf(`${secretArn}:password::`)).toBe(secretArn);
    expect(secretArnOf(`${secretArn}:password:AWSCURRENT:`)).toBe(secretArn);
    expect(secretArnOf(`${secretArn}:password::1a2b3c4d-1234-5678-9abc-0123456789ab`)).toBe(
      secretArn,
    );
  });
});
