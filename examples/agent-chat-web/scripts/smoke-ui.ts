import puppeteer from "puppeteer-core";

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--no-sandbox"],
});

const page = await browser.newPage();
page.setDefaultTimeout(150_000);
const errors: string[] = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(String(error)));

const clickText = async (text: string) => {
  await page.waitForFunction(
    (label) =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === label,
      ),
    {},
    text,
  );
  await page.evaluate((label) => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    (button as HTMLButtonElement | undefined)?.click();
  }, text);
};

const submit = async (placeholder: string, text: string) => {
  const input = await page.waitForSelector(`textarea[placeholder="${placeholder}"]`);
  await input!.type(text);
  await input!.evaluate((textarea) => {
    const form = textarea.closest("form");
    const button = form?.querySelector('button[type="submit"]');
    (button as HTMLButtonElement | null)?.click();
  });
};

await page.goto("http://localhost:5173/", { waitUntil: "networkidle0" });
console.log("stage: loaded");

// Channel Post → Thread → 1..* authored member responses.
await clickText("engineering");
await submit(
  "Start a Post in #engineering…",
  "Need both a quick take and a considered one: should a small internal tool use SQLite or Postgres?",
);
await page.waitForFunction(
  () =>
    document.body.textContent?.includes("Scout finished") &&
    document.body.textContent?.includes("Sage finished"),
  { timeout: 150_000 },
);
const engineering = await page.evaluate(() => document.body.innerText);
console.log("stage: engineering complete");

// Agent work is a clickable side channel.
await clickText("Scout finished");
await page.waitForFunction(
  () =>
    document.body.textContent?.toLowerCase().includes("scout's run") &&
    (document.body.textContent?.includes("run.admitted") ||
      document.body.textContent?.includes("model.requested")),
);
const inspector = await page.evaluate(() => document.body.innerText);
console.log("stage: inspector opened");
await page.click('button[aria-label="Close"]');

// Back to Posts, then a 1:1 DM.
await page.click('button[aria-label="Back"]');
await clickText("Scout");
const dmItemsBefore = await page.$$eval(
  '[data-slot="message-scroller-item"]',
  (items) => items.length,
);
await submit("Message Scout…", "In one sentence, what is your role?");
await page.waitForFunction(
  (before) =>
    document.querySelectorAll('[data-slot="message-scroller-item"]').length >=
      before + 2 && !document.body.textContent?.includes("working…"),
  {},
  dmItemsBefore,
);
const dm = await page.evaluate(() => document.body.innerText);
console.log("stage: dm complete");

// A prose-coordinated channel also produces an async member pill and
// relays the final member response.
await clickText("support");
await submit(
  "Start a Post in #support…",
  "I cannot log in after resetting my password. What should I try?",
);
try {
  await page.waitForFunction(
    () =>
      document.body.textContent?.includes("Helper finished") &&
      document.body.textContent?.includes("resolved"),
    { timeout: 45_000 },
  );
} catch (error) {
  console.error(
    await page.evaluate(() => ({
      innerText: document.body.innerText,
      textContent: document.body.textContent,
      items: [
        ...document.querySelectorAll('[data-slot="message-scroller-item"]'),
      ].map((item) => ({
        innerText: (item as HTMLElement).innerText,
        textContent: item.textContent,
      })),
      chat: document.querySelector("[data-debug-chat]")?.textContent,
    })),
  );
  await page.screenshot({ path: "/tmp/support-timeout.png", fullPage: true });
  throw error;
}
const support = await page.evaluate(() => document.body.innerText);
console.log("stage: support complete");

// Machine-observed goal: the model may cause close_issue, but the run
// settles only when the IssueClosed world event is observed.
await clickText("issues");
await submit(
  "Start a Post in #issues…",
  "Issue #12 is a documentation typo that is already fixed. Verify briefly and close it now.",
);
await page.waitForFunction(
  () => document.body.textContent?.includes("world exit observed"),
  { timeout: 150_000 },
);
const issues = await page.evaluate(() => document.body.innerText);
console.log("stage: issues complete");

// Trace panel is navigable.
await clickText("trace");
await page.waitForSelector("aside");
const trace = await page.evaluate(() => document.body.innerText);
console.log("stage: trace opened");

await page.screenshot({ path: "/tmp/alchemy-org-smoke.png", fullPage: true });
console.log(
  JSON.stringify(
    {
      engineering: {
        hasScout: engineering.includes("Scout"),
        hasSage: engineering.includes("Sage"),
        hasResolved: engineering.includes("resolved"),
        hasInspectorPill:
          engineering.includes("Scout is working") ||
          engineering.includes("Sage is working") ||
          engineering.includes("Scout finished") ||
          engineering.includes("Sage finished"),
      },
      inspector: {
        opened: inspector.toLowerCase().includes("scout's run"),
        hasRunFacts:
          inspector.includes("run.admitted") ||
          inspector.includes("model.requested"),
      },
      dm: {
        opened: dm.includes("Scout"),
        answered:
          dm.includes("In one sentence, what is your role?") &&
          !dm.includes("working…"),
      },
      support: {
        hasHelperPill: support.includes("Helper finished"),
        hasResolution: support.includes("resolved"),
      },
      issues: {
        observedExit: issues.includes("world exit observed"),
      },
      trace: trace.toLowerCase().includes("trace · issues"),
      errors,
      screenshot: "/tmp/alchemy-org-smoke.png",
    },
    undefined,
    2,
  ),
);

await browser.close();
