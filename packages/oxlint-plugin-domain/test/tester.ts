import * as path from "node:path";
import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

RuleTester.describe = describe;
RuleTester.it = it;

export const tester = new RuleTester({
  languageOptions: { sourceType: "module", parserOptions: { lang: "ts" } },
});

/** An absolute path inside the fixture package `test/fixtures/bank`. */
export const bank = (file: string): string =>
  path.join(import.meta.dirname, "fixtures", "bank", file);
