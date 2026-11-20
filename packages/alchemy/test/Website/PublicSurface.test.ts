import * as PublicWebsite from "alchemy/Website";
import * as InternalWebsite from "@/Website/Server";
import { describe, expect, it } from "alchemy-test";

describe("alchemy/Website public surface", { tags: ["unit"] }, () => {
  it("exports only the curated server API", () => {
    expect(Object.keys(PublicWebsite).sort()).toEqual([
      "FrameworkServerError",
      "Server",
      "ServerProvider",
    ]);
    expect(PublicWebsite.Server).toBe(InternalWebsite.Server);
    expect(PublicWebsite.ServerProvider).toBe(InternalWebsite.ServerProvider);
    expect(PublicWebsite.FrameworkServerError).toBe(
      InternalWebsite.FrameworkServerError,
    );
  });
});
