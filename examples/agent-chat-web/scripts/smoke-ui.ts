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

// Agent work is a clickable side channel.
await clickText("Scout finished");
await page.waitForFunction(
  () =>
    document.body.textContent?.toLowerCase().includes("scout's run") &&
    (document.body.textContent?.includes("run.admitted") ||
      document.body.textContent?.includes("model.requested")),
);
const inspector = await page.evaluate(() => document.body.innerText);
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

// A prose-coordinated channel also produces an async member pill and
// relays the final member response.
await clickText("support");
await submit(
  "Start a Post in #support…",
  "I cannot log in after resetting my password. What should I try?",
);
await page.waitForFunction(
  () =>
    document.body.textContent?.includes("Helper finished") &&
    document.body.textContent?.includes("resolved"),
  { timeout: 150_000 },
);
const support = await page.evaluate(() => document.body.innerText);

// Trace panel is navigable.
await clickText("trace");
await page.waitForSelector("aside");
const trace = await page.evaluate(() => document.body.innerText);

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
      trace: trace.toLowerCase().includes("trace · scout"),
      errors,
      screenshot: "/tmp/alchemy-org-smoke.png",
    },
    undefined,
    2,
  ),
);

await browser.close();
