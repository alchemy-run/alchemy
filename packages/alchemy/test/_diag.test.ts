import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import { expect } from "@effect/vitest";
import { test } from "vitest";
test("diag", () => {
  const lbm = (Cloudflare as any).LoadBalancerMonitor;
  const r = Provider.findProvider(lbm);
  expect({
    lbmType: typeof lbm,
    dotType: lbm?.Type,
    rType: typeof r,
    rNull: r == null,
    hasIter: typeof (r as any)?.[Symbol.iterator],
  }).toEqual("SHOW");
});
