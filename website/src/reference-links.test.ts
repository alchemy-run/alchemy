import { describe, expect, test } from "bun:test";
import { referenceDestination, rewriteReferenceLinks } from "./reference-links";
import worker from "./worker";

describe("consolidated reference links", () => {
  test("resource URLs and legacy section links resolve to service anchors", () => {
    expect(referenceDestination("/providers/aws/s3/bucket/")).toBe(
      "/providers/aws/s3#bucket",
    );
    expect(
      referenceDestination(
        "/providers/aws/s3/bucket?from=guide#creating-a-bucket",
      ),
    ).toBe("/providers/aws/s3?from=guide#bucket-creating-a-bucket");
    expect(referenceDestination("/providers/aws/s3/bucket.md?from=agent")).toBe(
      "/providers/aws/s3.md?from=agent",
    );
    expect(referenceDestination("/providers/aws/s3#bucket")).toBeUndefined();
    expect(referenceDestination("/providers/aws/s3/unknown")).toBeUndefined();
  });

  test("HTML and Markdown links are rewritten without changing unrelated text", () => {
    expect(
      rewriteReferenceLinks('<a href="/providers/aws/s3/bucket">Bucket</a>'),
    ).toBe('<a href="/providers/aws/s3#bucket">Bucket</a>');
    expect(
      rewriteReferenceLinks(
        "[Bucket](/providers/aws/s3/bucket) and /providers/aws/s3/bucket",
      ),
    ).toBe("[Bucket](/providers/aws/s3#bucket) and /providers/aws/s3/bucket");
  });

  test("the Worker redirects before fetching assets or probing v1", async () => {
    const response = await worker.fetch(
      new Request("https://alchemy.run/providers/aws/s3/bucket?from=old"),
      {} as never,
    );
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(
      "https://alchemy.run/providers/aws/s3?from=old#bucket",
    );
    const markdown = await worker.fetch(
      new Request("https://alchemy.run/providers/aws/s3/bucket.md"),
      {} as never,
    );
    expect(markdown.headers.get("location")).toBe(
      "https://alchemy.run/providers/aws/s3.md",
    );
  });
});
