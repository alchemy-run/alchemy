// A Worker bundle installs runtime shims. Evaluate it in its own process so
// those shims cannot replace the test runner's process/execPath globals.
const entry = process.argv[2]!;
const report = process.stdout.write.bind(process.stdout);
const handler = await import(entry);
const response: Response = await handler.default.fetch(
  new Request("https://example.test/?count=7"),
);
const missing: Response = await handler.default.fetch(
  new Request("https://example.test/assets/missing.js"),
);
report(
  JSON.stringify({
    status: response.status,
    html: await response.text(),
    missingStatus: missing.status,
  }),
);
