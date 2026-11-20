import { resolvePolicies, type Policy } from "@alchemy.run/cloudflare/ApiToken";
import { describe, expect, it } from "@alchemy.run/test";

const ACCOUNT_KEY = "com.cloudflare.api.account.123456789012";
const ZONE_KEY = "com.cloudflare.api.account.zone.*";

// "Access: Apps and Policies Write" is one name for two groups: the zone-scoped
// group is listed first in the catalog, the account-scoped one second.
const ACCOUNT_GROUP = "1e13c5124ca64b72b1969a67e8829049";
const ZONE_GROUP = "959972745952452f8be2452be8cbb9f2";

const resolve = (resources: Policy["resources"], name: Policy["permissionGroups"][number]) =>
  resolvePolicies([{ effect: "allow", permissionGroups: [name], resources }])[0]!
    .permissionGroups[0]!.id;

describe(
  "API token permission group names shared by several scopes",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:apitoken", "local"] },
  () => {
    it("resolves to the account group for an account resource key", () => {
      expect(resolve({ [ACCOUNT_KEY]: "*" }, "Access: Apps and Policies Write")).toEqual(
        ACCOUNT_GROUP,
      );
    });

    it("resolves to the zone group for a zone resource key", () => {
      expect(resolve({ [ZONE_KEY]: "*" }, "Access: Apps and Policies Write")).toEqual(ZONE_GROUP);
    });

    it("resolves to the zone group for a zone key nested under the account key", () => {
      expect(
        resolve({ [ACCOUNT_KEY]: { [ZONE_KEY]: "*" } }, "Access: Apps and Policies Write"),
      ).toEqual(ZONE_GROUP);
    });

    it("refuses a name when the resources don't single out one group", () => {
      expect(() =>
        resolve({ [ACCOUNT_KEY]: "*", [ZONE_KEY]: "*" }, "Access: Apps and Policies Write"),
      ).toThrow(/more than one scope/);
      expect(() => resolve({}, "Access: Apps and Policies Write")).toThrow(/more than one scope/);
    });

    it("still takes an explicit id as given", () => {
      expect(resolve({ [ACCOUNT_KEY]: "*" }, { id: ZONE_GROUP })).toEqual(ZONE_GROUP);
    });

    it("resolves a name that only one group has, whatever the resources", () => {
      expect(resolve({ [ACCOUNT_KEY]: "*" }, "Workers Scripts Read")).toEqual(
        resolve({ [ZONE_KEY]: "*" }, "Workers Scripts Read"),
      );
    });
  },
);
