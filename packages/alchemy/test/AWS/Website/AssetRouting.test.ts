import { CF_ROUTER_INJECTION } from "@/AWS/Website/cfcode.ts";
import { describe, expect, it } from "alchemy-test";

const route = async (
  method: string,
  options: {
    server?: boolean;
    match?: boolean;
    prefix?: boolean;
    custom404?: boolean;
  } = {},
) => {
  const request = {
    method,
    uri: "/about/",
    headers: { host: { value: "app.example.com" } },
    cookies: { session: { value: "counter" } },
    querystring: { count: { value: "7" } },
  };
  const origins: Array<{ domainName: string }> = [];
  let lookups = 0;
  const cf = {
    kvs: () => ({
      async get(key: string) {
        lookups++;
        if (options.match !== false && key === "site:/about/index.html")
          return "1";
        throw new Error("Not Found");
      },
    }),
    updateRequestOrigin: (origin: { domainName: string }) =>
      origins.push(origin),
  };
  const metadata = {
    s3: {
      domain: "assets.s3.example.com",
      dir: "/site",
      routes: options.prefix ? ["/about"] : undefined,
    },
    servers:
      options.server === false
        ? undefined
        : [["server.lambda-url.example.com"]],
    custom404: options.custom404 ? "/404.html" : undefined,
  };
  const run = new Function(
    "event",
    "cf",
    "metadata",
    `${CF_ROUTER_INJECTION}\nreturn routeSite("site", metadata);`,
  );
  await run({ request }, cf, metadata);
  return { request, origins, lookups };
};

describe("AWS website asset routing", { tags: ["unit", "local"] }, () => {
  for (const method of ["GET", "HEAD"]) {
    it(`${method} serves a prerendered page from S3`, async () => {
      const result = await route(method);
      expect(result.origins[0]?.domainName).toBe("assets.s3.example.com");
      expect(result.request.uri).toBe("/site/about/index.html");
    });
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    it(`${method} reaches the server despite static pages, route prefixes or a 404 page`, async () => {
      const result = await route(method, { prefix: true, custom404: true });
      expect(result.origins[0]?.domainName).toBe(
        "server.lambda-url.example.com",
      );
      expect(result.lookups).toBe(0);
      expect(result.request.uri).toBe("/about/");
      expect(result.request.cookies.session.value).toBe("counter");
      expect(result.request.querystring.count.value).toBe("7");
    });
  }
  it("GET misses reach the server", async () => {
    expect((await route("GET", { match: false })).origins[0]?.domainName).toBe(
      "server.lambda-url.example.com",
    );
  });
  it("preserves asset-only routing without a server origin", async () => {
    expect(
      (await route("POST", { server: false })).origins[0]?.domainName,
    ).toBe("assets.s3.example.com");
  });
});
