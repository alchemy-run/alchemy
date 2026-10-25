import * as assert from "node:assert/strict";
import { test } from "node:test";
import { domainRules, serverRules, strictRules } from "../src/configs.ts";
import { rules } from "../src/index.ts";

const names = (config: Record<string, unknown>) =>
  Object.keys(config).map((id) => id.replace(/^alchemy-domain\//, ""));

test("every config entry names a rule of the plugin", () => {
  for (const name of [...names(domainRules), ...names(serverRules), ...names(strictRules)]) {
    assert.ok(name in rules, `${name} is not a rule`);
  }
});

test("every rule is in domainRules or strictRules, not both", () => {
  const domain = names(domainRules);
  const strict = names(strictRules);
  assert.deepEqual([...domain, ...strict].sort(), Object.keys(rules).sort());
  assert.deepEqual(
    domain.filter((name) => strict.includes(name)),
    [],
  );
});

test("strict rules only warn", () => {
  assert.deepEqual(new Set(Object.values(strictRules)), new Set(["warn"]));
});
