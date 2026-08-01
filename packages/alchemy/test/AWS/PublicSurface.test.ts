import * as Credentials from "alchemy/AWS/Credentials";
import * as Endpoint from "alchemy/AWS/Endpoint";
import * as Region from "alchemy/AWS/Region";
import { describe, expect, it } from "alchemy-test";
import { readFileSync } from "node:fs";

describe("AWS public surface", () => {
  it("resolves utility subpath exports", () => {
    expect(Credentials.fromEnvironment).toBeDefined();
    expect(Endpoint.of).toBeDefined();
    expect(Region.of).toBeDefined();
  });

  it("does not expose the removed Profile module", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );

    expect(packageJson.exports["./AWS/Profile"]).toBeUndefined();
  });
});
