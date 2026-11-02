import { previewIdentifier, previewReference } from "@alchemy.run/convex/internal/references";
import { expect, it as test } from "@alchemy.run/test";

test("previewReference is what Convex stores for a stage", () => {
  expect(previewReference("fix-login-42")).toBe("preview/fix-login-42");
  expect(previewReference("Christian_Stamati")).toBe("preview/christian-stamati");
});

test("previewIdentifier matches how Convex normalises what it is sent", () => {
  expect(previewIdentifier("a/b/c")).toBe("a-b-c");
});

test("previewIdentifier always has a usable value", () => {
  expect(previewIdentifier("___").length).toBeGreaterThan(0);
});

test("long stages stay within 100 characters and stay distinct", () => {
  const a = previewReference(`${"a".repeat(120)}1`);
  const b = previewReference(`${"a".repeat(120)}2`);
  expect(a.length).toBeLessThanOrEqual(100);
  expect(a).not.toBe(b);
});
