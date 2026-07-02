import {
  collectAwsRequirements,
  toPolicyDocument,
} from "@/AWS/Requirements.ts";
import {
  collectCloudflareRequirements,
  suggestOAuthScopes,
} from "@/Cloudflare/Auth/Requirements.ts";
import type {
  AlchemyProviderMetadata,
  StackProviderMetadata,
} from "@/index.ts";
import { describe, expect, it } from "@effect/vitest";

const metadata = (
  entries: Record<string, AlchemyProviderMetadata>,
  used?: string[],
): StackProviderMetadata => {
  const all = new Map(Object.entries(entries));
  return used === undefined
    ? { all }
    : {
        all,
        used: new Map(used.map((type) => [type, all.get(type)!])),
      };
};

const worker: AlchemyProviderMetadata = {
  cloudflare: {
    scope: "account",
    auth: {
      oauth: { scopes: ["workers:write", "workers_scripts:write"] },
      token: {
        permissionGroups: [
          {
            id: "e086da7e2179491d91ee5f35b3ca210a",
            name: "Workers Scripts Write",
          },
        ],
      },
    },
  },
};

const zoneSetting: AlchemyProviderMetadata = {
  cloudflare: {
    scope: "zone",
    auth: {
      oauth: { supported: false },
      token: {
        permissionGroups: [
          {
            id: "9ff81cbbe65c400b97d92c3c1033cab6",
            name: "Cache Settings Write",
          },
        ],
      },
    },
  },
};

const bucket: AlchemyProviderMetadata = {
  aws: {
    iam: {
      actions: ["s3:CreateBucket", "s3:DeleteBucket"],
      readActions: ["s3:ListAllMyBuckets"],
      notes: "headBucket authorizes as s3:ListBucket.",
    },
  },
};

describe("Cloudflare Requirements", () => {
  it("unions scopes and permission groups over the used subset", () => {
    const requirements = collectCloudflareRequirements(
      metadata(
        { "CF.Worker": worker, "CF.Cache": zoneSetting, "AWS.Bucket": bucket },
        ["CF.Worker", "CF.Cache"],
      ),
    );
    expect([...requirements.oauthScopes.keys()].sort()).toEqual([
      "workers:write",
      "workers_scripts:write",
    ]);
    expect(requirements.oauthScopes.get("workers:write")).toEqual([
      "CF.Worker",
    ]);
    expect(requirements.oauthUnsupported).toEqual(["CF.Cache"]);
    expect(requirements.hasZoneScoped).toBe(true);
    expect(
      requirements.permissionGroups.get("e086da7e2179491d91ee5f35b3ca210a"),
    ).toEqual({ name: "Workers Scripts Write", resourceTypes: ["CF.Worker"] });
    expect(requirements.permissionGroups.size).toBe(2);
  });

  it("falls back to `all` when no used subset exists", () => {
    const requirements = collectCloudflareRequirements(
      metadata({ "CF.Worker": worker }),
    );
    expect(requirements.oauthScopes.size).toBe(2);
  });

  it("suggests base scopes plus required scopes, zone:read only when zone-scoped", () => {
    const withZone = collectCloudflareRequirements(
      metadata({ "CF.Worker": worker, "CF.Cache": zoneSetting }),
    );
    expect(suggestOAuthScopes(withZone)).toEqual([
      "account:read",
      "user:read",
      "workers:write",
      "workers_scripts:write",
      "zone:read",
    ]);
    const accountOnly = collectCloudflareRequirements(
      metadata({ "CF.Worker": worker }),
    );
    expect(suggestOAuthScopes(accountOnly)).not.toContain("zone:read");
  });
});

describe("AWS Requirements", () => {
  it("unions actions with resource attribution and renders a policy document", () => {
    const requirements = collectAwsRequirements(
      metadata({ "AWS.Bucket": bucket, "CF.Worker": worker }),
    );
    expect(requirements.actions.get("s3:CreateBucket")).toEqual(["AWS.Bucket"]);
    expect(requirements.notes).toEqual([
      {
        resourceType: "AWS.Bucket",
        note: "headBucket authorizes as s3:ListBucket.",
      },
    ]);

    const policy = toPolicyDocument(requirements);
    expect(policy.Statement[0]!.Action).toEqual([
      "s3:CreateBucket",
      "s3:DeleteBucket",
      "s3:ListAllMyBuckets",
    ]);
    const planOnly = toPolicyDocument(requirements, { planOnly: true });
    expect(planOnly.Statement[0]!.Action).toEqual(["s3:ListAllMyBuckets"]);
  });
});
