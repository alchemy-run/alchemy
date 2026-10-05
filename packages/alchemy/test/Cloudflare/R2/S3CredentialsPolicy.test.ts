import { describe, expect, it } from "alchemy-test";
import { PERMISSION_GROUPS_BY_NAME } from "@/Cloudflare/ApiToken/PermissionGroups.ts";
import type { S3CredentialsAccess } from "@/Cloudflare/R2/S3Credentials.ts";
import { s3CredentialsPolicy } from "@/Cloudflare/R2/S3CredentialsBinding.ts";

const ACCOUNT_ID = "4793d734c0b8e484dfc37ec392b5fa8a";
const ACCESS: S3CredentialsAccess[] = ["read", "write", "read-write"];

describe("s3CredentialsPolicy", { tags: ["unit", "provider:cloudflare", "local"] }, () => {
  it("scopes the token to the bucket, never the account", () => {
    for (const access of ACCESS) {
      expect(s3CredentialsPolicy(ACCOUNT_ID, "uploads", "default", access).resources).toEqual({
        [`com.cloudflare.edge.r2.bucket.${ACCOUNT_ID}_default_uploads`]: "*",
      });
    }
  });

  it("puts a jurisdictional bucket's jurisdiction in the resource key", () => {
    expect(s3CredentialsPolicy(ACCOUNT_ID, "uploads-eu", "eu", "read").resources).toEqual({
      [`com.cloudflare.edge.r2.bucket.${ACCOUNT_ID}_eu_uploads-eu`]: "*",
    });
    expect(s3CredentialsPolicy(ACCOUNT_ID, "gov", "fedramp", "write").resources).toEqual({
      [`com.cloudflare.edge.r2.bucket.${ACCOUNT_ID}_fedramp_gov`]: "*",
    });
  });

  it("grants bucket-item permission groups per access level", () => {
    expect(s3CredentialsPolicy(ACCOUNT_ID, "b", "default", "read")).toMatchObject({
      effect: "allow",
      permissionGroups: ["Workers R2 Storage Bucket Item Read"],
    });
    expect(s3CredentialsPolicy(ACCOUNT_ID, "b", "default", "write")).toMatchObject({
      effect: "allow",
      permissionGroups: ["Workers R2 Storage Bucket Item Write"],
    });
    expect(s3CredentialsPolicy(ACCOUNT_ID, "b", "eu", "read-write")).toMatchObject({
      effect: "allow",
      permissionGroups: [
        "Workers R2 Storage Bucket Item Read",
        "Workers R2 Storage Bucket Item Write",
      ],
    });
  });

  // A group whose scope differs from the resource type grants nothing on it.
  it("uses only groups that apply to the bucket resource type", () => {
    for (const access of ACCESS) {
      for (const ref of s3CredentialsPolicy(ACCOUNT_ID, "b", "default", access).permissionGroups) {
        expect(typeof ref).toBe("string");
        if (typeof ref === "string") {
          expect(PERMISSION_GROUPS_BY_NAME[ref].scopes).toEqual(["com.cloudflare.edge.r2.bucket"]);
        }
      }
    }
  });
});
