import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { BRANCH_PREFIX } from "../util.ts";
// must import this or else alchemy.test won't exist
import "../../src/test/vitest.ts";
import { formatBytes } from "../../src/util/format.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("formatBytes", () => {
  test("fit", async () => {
    expect(formatBytes(88)).toEqual("88 bytes");
    expect(formatBytes(1000)).toEqual("1000 bytes");
    expect(formatBytes(1024)).toEqual("1 KB");
    expect(formatBytes(1024 * 1024)).toEqual("1 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toEqual("1 GB");
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toEqual("1 TB");
    expect(formatBytes(1024 * 1024 * 1024 * 1024 * 1024)).toEqual("1 PB");
  });
  test("bytes", async () => {
    expect(formatBytes(88, "bytes")).toEqual("88 bytes");
    expect(formatBytes(1000, "bytes")).toEqual("1000 bytes");
    expect(formatBytes(1024, "bytes")).toEqual("1024 bytes");
    expect(formatBytes(1024 * 1024, "bytes")).toEqual("1048576 bytes");
    expect(formatBytes(1024 * 1024 * 1024, "bytes")).toEqual(
      "1073741824 bytes",
    );
    expect(formatBytes(1024 * 1024 * 1024 * 1024, "bytes")).toEqual(
      "1099511627776 bytes",
    );
    expect(formatBytes(1024 * 1024 * 1024 * 1024 * 1024, "bytes")).toEqual(
      "1125899906842624 bytes",
    );
  });
  test("KB", async () => {
    expect(formatBytes(88, "KB")).toEqual("0.09 KB");
    expect(formatBytes(1024, "KB")).toEqual("1 KB");
    expect(formatBytes(1024 * 1024, "KB")).toEqual("1024 KB");
    expect(formatBytes(1024 * 1024 * 1024, "KB")).toEqual("1048576 KB");
    expect(formatBytes(1024 * 1024 * 1024 * 1024, "KB")).toEqual(
      "1073741824 KB",
    );
    expect(formatBytes(1024 * 1024 * 1024 * 1024 * 1024, "KB")).toEqual(
      "1099511627776 KB",
    );
  });
  test("MB", async () => {
    expect(formatBytes(1024 * 1024, "MB")).toEqual("1 MB");
    expect(formatBytes(1024 * 1024 * 1024, "MB")).toEqual("1024 MB");
    expect(formatBytes(1024 * 1024 * 1024 * 1024, "MB")).toEqual("1048576 MB");
    expect(formatBytes(1024 * 1024 * 1024 * 1024 * 1024, "MB")).toEqual(
      "1073741824 MB",
    );
  });
  test("GB", async () => {
    expect(formatBytes(1024 * 1024 * 1024, "GB")).toEqual("1 GB");
    expect(formatBytes(1024 * 1024 * 1024 * 1024, "GB")).toEqual("1024 GB");
    expect(formatBytes(1024 * 1024 * 1024 * 1024 * 1024, "GB")).toEqual(
      "1048576 GB",
    );
  });
  test("TB", async () => {
    expect(formatBytes(1024 * 1024 * 1024 * 1024, "TB")).toEqual("1 TB");
    expect(formatBytes(1024 * 1024 * 1024 * 1024 * 1024, "TB")).toEqual(
      "1024 TB",
    );
  });
  test("PB", async () => {
    expect(formatBytes(1024 * 1024 * 1024 * 1024 * 1024, "PB")).toEqual("1 PB");
    expect(formatBytes(1024 * 1024 * 1024 * 1024 * 1024 * 1024, "PB")).toEqual(
      "1024 PB",
    );
  });
});
