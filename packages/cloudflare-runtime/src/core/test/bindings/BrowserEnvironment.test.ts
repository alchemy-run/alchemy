// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
// Adapted from Miniflare's `test/plugins/browser/environment.spec.ts` (#16612).
import { test } from "vitest";
import { getBrowserEnvironment } from "../../bindings/browser/BrowserEnvironment.ts";

test("preserves Windows configuration with case-insensitive environment names", ({ expect }) => {
  const env = getBrowserEnvironment(
    "unused-profile",
    {
      hOmE: "C:\\Users\\developer",
      pAtH: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      SystemDrive: "C:",
      LocalAppData: "C:\\Users\\developer\\AppData\\Local",
      AppData: "C:\\Users\\developer\\AppData\\Roaming",
      UserProfile: "C:\\Users\\developer",
      Temp: "C:\\Users\\developer\\AppData\\Local\\Temp",
      hTtPs_PrOxY: "http://127.0.0.1:9000",
      cLoUdFlArE_aPi_ToKeN: "synthetic-secret",
    },
    "win32",
  );

  expect(env).toEqual({
    HOME: "C:\\Users\\developer",
    PATH: "C:\\Windows\\System32",
    SYSTEMROOT: "C:\\Windows",
    SYSTEMDRIVE: "C:",
    LOCALAPPDATA: "C:\\Users\\developer\\AppData\\Local",
    APPDATA: "C:\\Users\\developer\\AppData\\Roaming",
    USERPROFILE: "C:\\Users\\developer",
    TEMP: "C:\\Users\\developer\\AppData\\Local\\Temp",
    HTTPS_PROXY: "http://127.0.0.1:9000",
  });
});

test("preserves distinct POSIX proxy settings without accepting lookalike names", ({ expect }) => {
  const env = getBrowserEnvironment(
    "unused-profile",
    {
      HOME: "/home/developer",
      PATH: "/usr/bin",
      HTTP_PROXY: "http://127.0.0.1:9000",
      http_proxy: "http://127.0.0.1:9001",
      Home: "ignored-home",
      path: "ignored-path",
      XDG_TEST_TOKEN: "synthetic-secret",
      HTTP_PROXY_TOKEN: "synthetic-secret",
      LD_PRELOAD: "/unused-library",
      DYLD_INSERT_LIBRARIES: "/unused-library",
    },
    "linux",
  );

  expect(env).toEqual({
    HOME: "/home/developer",
    PATH: "/usr/bin",
    HTTP_PROXY: "http://127.0.0.1:9000",
    http_proxy: "http://127.0.0.1:9001",
  });
});
