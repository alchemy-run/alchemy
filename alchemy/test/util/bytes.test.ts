import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { BRANCH_PREFIX } from "../util.ts";
// must import this or else alchemy.test won't exist
import "../../src/test/vitest.ts";
import { formatBytes, parseBytes } from "../../src/util/bytes.ts";

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

describe("parseBytes", () => {
  test("bytes", async () => {
    expect(parseBytes("88 bytes")).toEqual(88);
    expect(parseBytes("1000 B")).toEqual(1000);
    expect(parseBytes("1000b")).toEqual(1000);
    expect(parseBytes("200000bytes")).toEqual(200000);
  });
  test("KB", async () => {
    expect(parseBytes("88 KB")).toEqual(88 * 1024);
    expect(parseBytes("1000 kb")).toEqual(1000 * 1024);
    expect(parseBytes("200000KB")).toEqual(200000 * 1024);
  });
  test("MB", async () => {
    expect(parseBytes("88 MB")).toEqual(88 * 1024 * 1024);
    expect(parseBytes("1000 mb")).toEqual(1000 * 1024 * 1024);
    expect(parseBytes("200000MB")).toEqual(200000 * 1024 * 1024);
  });
  test("GB", async () => {
    expect(parseBytes("88 GB")).toEqual(88 * 1024 * 1024 * 1024);
    expect(parseBytes("1000 gb")).toEqual(1000 * 1024 * 1024 * 1024);
    expect(parseBytes("200000GB")).toEqual(200000 * 1024 * 1024 * 1024);
  });
  test("TB", async () => {
    expect(parseBytes("88 TB")).toEqual(88 * 1024 * 1024 * 1024 * 1024);
    expect(parseBytes("1000 tb")).toEqual(1000 * 1024 * 1024 * 1024 * 1024);
    expect(parseBytes("200000TB")).toEqual(200000 * 1024 * 1024 * 1024 * 1024);
  });
  test("PB", async () => {
    expect(parseBytes("88 PB")).toEqual(88 * 1024 * 1024 * 1024 * 1024 * 1024);
    expect(parseBytes("1000 pb")).toEqual(
      1000 * 1024 * 1024 * 1024 * 1024 * 1024,
    );
    expect(parseBytes("200000PB")).toEqual(
      200000 * 1024 * 1024 * 1024 * 1024 * 1024,
    );
  });
  // test("EB", async () => {
  //   expect(parseBytes("88 EB")).toEqual(
  //     88 * 1024 * 1024 * 1024 * 1024 * 1024 * 1024,
  //   );
  //   expect(parseBytes("1000 eb")).toEqual(
  //     1000 * 1024 * 1024 * 1024 * 1024 * 1024 * 1024,
  //   );
  //   expect(parseBytes("200000EB")).toEqual(
  //     200000 * 1024 * 1024 * 1024 * 1024 * 1024 * 1024,
  //   );
  // });
  // test("ZB", async () => {
  //   expect(parseBytes("88 ZB")).toEqual(
  //     88 * 1024 * 1024 * 1024 * 1024 * 1024 * 1024 * 1024,
  //   );
  //   expect(parseBytes("1000 zb")).toEqual(
  //     1000 * 1024 * 1024 * 1024 * 1024 * 1024 * 1024 * 1024,
  //   );
  //   expect(parseBytes("200000ZB")).toEqual(
  //     200000 * 1024 * 1024 * 1024 * 1024 * 1024 * 1024 * 1024,
  //   );
  // });
  // test("YB", async () => {
  //   expect(parseBytes("88 YB")).toEqual(
  //     88 * 1024 * 1024 * 1024 * 1024 * 1024 * 1024 * 1024 * 1024,
  //   );
  //   expect(parseBytes("1000 YB")).toEqual(
  //     1000 * 1024 * 1024 * 1024 * 1024 * 1024 * 1024 * 1024 * 1024,
  //   );
  //   expect(parseBytes("200000YB")).toEqual(
  //     200000 * 1024 * 1024 * 1024 * 1024 * 1024 * 1024 * 1024 * 1024,
  //   );
  // });
});
