import { describe, expect, it } from "vitest";
import {
  LAMBDA_ADAPTER_FILE_NAME,
  SERVE_ENTRY_NAME,
  makeAwsTarget,
  makeLambdaEntrySource,
  target,
} from "../aws.ts";

describe("makeAwsTarget", () => {
  it("declares the aws platform and a wholesale vinext build (not OpenNext)", () => {
    const aws = makeAwsTarget();
    expect(aws.platform).toBe("aws");
    expect(aws.build).toBeTypeOf("function");
    expect(aws.bundle?.conditions).toContain("node");
    expect(aws.bundle?.external).toContain("@aws-sdk/");
    expect(aws.bundle?.external ?? []).not.toContain("cloudflare:");
  });

  it("wraps the App Router fetch handler as a streaming Lambda handler", () => {
    const source = makeLambdaEntrySource(true);
    expect(SERVE_ENTRY_NAME).toBe("server/serve-aws-lambda.mjs");
    expect(LAMBDA_ADAPTER_FILE_NAME).toBe("vinext-aws-lambda.mjs");
    expect(source).toContain('import rsc from "./index.js"');
    expect(source).toContain("toLambdaHandler");
    expect(source).toContain("export const handler");
    expect(source).toContain('hostRuntime: "node"');
    expect(source).not.toContain("toBufferedLambdaHandler");
    expect(source).not.toContain("opennext");
    expect(source).not.toContain("vinext/server/fetch-handler");
    expect(source).not.toContain("startProdServer");
  });

  it("can emit the buffered Lambda wrapper", () => {
    const source = makeLambdaEntrySource(false);
    expect(source).toContain("toBufferedLambdaHandler");
    expect(source).not.toContain("toLambdaHandler");
  });

  it("exposes the named `target` module export as the factory", () => {
    expect(target).toBe(makeAwsTarget);
  });
});
