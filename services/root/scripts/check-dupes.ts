/** Fresh-load duplication check: count renderings of known messages. */
import puppeteer from "puppeteer-core";

const URL = process.argv[2] ?? "http://localhost:60518";

const browser = await puppeteer.launch({
  executablePath:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 2400 });
await page.goto(URL, { waitUntil: "networkidle2", timeout: 60_000 });
await new Promise((resolve) => setTimeout(resolve, 3000));

const counts = await page.evaluate(() => {
  const text = document.body.innerText;
  const count = (needle: string) => text.split(needle).length - 1;
  return {
    monorepoAnswer: count("This is a monorepo with packages"),
    memoryAnswer: count("This conversation just started"),
    hiAnswer: count("Ready to help"),
    hi: count("hi"),
  };
});
console.log(JSON.stringify(counts, null, 2));
await browser.close();
