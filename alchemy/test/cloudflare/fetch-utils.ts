/**
 * Utility functions for making HTTP requests with retry logic for Cloudflare's
 * eventually consistent control plane.
 */

import { expect } from "vitest";
import { fetchAndExpectOK } from "../../src/util/safe-fetch.ts";

export async function fetchAndExpect(url: string, expected: string) {
  const response = await fetchAndExpectOK(url);
  const text = await response.text();
  expect(text).toEqual(expected);
}
