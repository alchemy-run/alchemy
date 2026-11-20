// Check every Tree diagram on the given docs pages at desktop (1280px) and
// phone (390px) widths, and screenshot each one for review.
//
// Usage (dev server running: pnpm exec astro dev in website/):
//   node tree-check.mjs http://localhost:4321 /tmp/trees aws/what-is-aws cloudflare/what-is-cloudflare
//   node tree-check.mjs http://localhost:4321 /tmp/trees --all     # every page with a <Tree>
//
// It reports, per figure: boxes in an unplaced row that don't end flush, empty
// space under a container's contents, text spilling out of its box or the
// panel, arrows with no clear route, arrows that cross or run along each other
// (unless they share a source or target), arrows through a heading, arrowheads
// on stubs too short to carry them, and labels on a border, a line, text or
// another label. Then read the screenshots: a clean report is necessary, not
// sufficient.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const pnpm = path.join(root, "node_modules/.pnpm");
const pw = fs
  .readdirSync(pnpm)
  .filter((d) => /^playwright@\d/.test(d))
  .sort()
  .at(-1);
const { chromium } = await import(path.join(pnpm, pw, "node_modules/playwright/index.mjs"));
const chrome = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => fs.existsSync(p));

let [base, out, ...paths] = process.argv.slice(2);
if (paths[0] === "--all") {
  const docs = path.join(root, "website/src/content/docs");
  paths = fs
    .readdirSync(docs, { recursive: true })
    .filter(
      (f) => /\.mdx?$/.test(f) && fs.readFileSync(path.join(docs, f), "utf8").includes("<Tree"),
    )
    .map((f) => f.replace(/\.mdx?$/, "").replace(/\/index$/, ""))
    .sort((a, b) => a.localeCompare(b));
}
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch(chrome ? { executablePath: chrome } : {});
const widths = { desktop: 1280, phone: 390 };
const problems = [];
for (const [wname, w] of Object.entries(widths)) {
  const page = await browser.newPage({
    viewport: { width: w, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });
  for (const p of paths) {
    await page.goto(`${base}/${p}/`, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    const res = await page.evaluate(() => {
      const out = [];
      const figs = [...document.querySelectorAll("figure.alc-fig")].filter((f) =>
        f.querySelector(".alc-tree"),
      );
      figs.forEach((fig, i) => {
        const panel = fig.querySelector(".alc-fig__panel").getBoundingClientRect();
        for (const c of fig.querySelectorAll(
          ".alc-tree__kids, .alc-tree__side, .alc-tree__split",
        )) {
          const kids = [...c.children].filter((k) => getComputedStyle(k).display !== "none");
          const dir = getComputedStyle(c).flexDirection;
          if (dir.startsWith("row") && getComputedStyle(c).display !== "grid") {
            const lines = new Map();
            for (const k of kids) {
              const r = k.getBoundingClientRect();
              const key = Math.round(r.top);
              lines.set(key, [...(lines.get(key) ?? []), r]);
            }
            for (const rs of lines.values()) {
              const bottoms = rs.map((r) => Math.round(r.bottom));
              if (Math.max(...bottoms) - Math.min(...bottoms) > 1)
                out.push(`fig ${i}: ragged row in ${c.className} (${bottoms.join(",")})`);
            }
          }
        }
        for (const box of fig.querySelectorAll(".alc-tree__box")) {
          const cs = getComputedStyle(box);
          const inner =
            box.getBoundingClientRect().bottom -
            parseFloat(cs.paddingBottom) -
            parseFloat(cs.borderBottomWidth);
          const leaves = [
            ...box.querySelectorAll(
              ":scope > .alc-tree__kids > *, :scope > .alc-tree__split > * > *",
            ),
          ];
          const lowest = Math.max(...leaves.map((l) => l.getBoundingClientRect().bottom));
          if (leaves.length && inner - lowest > 2)
            out.push(
              `fig ${i}: ${Math.round(inner - lowest)}px empty under ${box.querySelector(".alc-tree__label")?.textContent}`,
            );
        }
        const hit = (a, b) =>
          a.left < b.right - 1 &&
          a.right > b.left + 1 &&
          a.top < b.bottom - 1 &&
          a.bottom > b.top + 1;
        const inside = (a, b) =>
          a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom;
        const labels = [...fig.querySelectorAll(".alc-tree__link-label")].map((t) => ({
          name: t.textContent ?? "",
          L: t.getBoundingClientRect(),
        }));
        const solids = [...fig.querySelectorAll("[data-node]")];
        const texts = [
          ...fig.querySelectorAll(
            ".alc-tree__label, .alc-tree__type, .alc-tree__icon, .alc-tree__scope",
          ),
        ];
        for (const { name, L } of labels) {
          for (const el of solids) {
            const R = el.getBoundingClientRect();
            if (hit(L, R) && !inside(L, R))
              out.push(`fig ${i}: label "${name}" on the border of ${el.dataset.node}`);
          }
          for (const el of texts)
            if (hit(L, el.getBoundingClientRect()))
              out.push(`fig ${i}: label "${name}" over text "${el.textContent}"`);
          for (const { name: n2, L: L2 } of labels)
            if (L2 !== L && hit(L, L2)) out.push(`fig ${i}: labels "${name}" and "${n2}" overlap`);
          for (const p of fig.querySelectorAll(".alc-tree__link")) {
            // a label must not sit across a line
            const len = p.getTotalLength();
            for (let d = 0; d < len; d += 2) {
              const q = p.getPointAtLength(d);
              const r = fig.querySelector(".alc-tree").getBoundingClientRect();
              const x = q.x + r.left,
                y = q.y + r.top;
              if (x > L.left + 1 && x < L.right - 1 && y > L.top + 2 && y < L.bottom - 2) {
                out.push(`fig ${i}: label "${name}" across a line`);
                break;
              }
            }
          }
        }
        for (const p of fig.querySelectorAll(".alc-tree__link")) {
          const pts = [...p.getAttribute("d").matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [
            +m[1],
            +m[2],
          ]);
          const [x1, y1] = pts.at(-2),
            [x2, y2] = pts.at(-1);
          const last = Math.hypot(x2 - x1, y2 - y1);
          if (last < 16)
            out.push(
              `fig ${i}: arrowhead on a ${Math.round(last)}px stub (${p.getAttribute("d")})`,
            );
        }
        {
          const paths = [...fig.querySelectorAll(".alc-tree__link")];
          const segs = paths.map((p) => {
            const pts = [...p.getAttribute("d").matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [
              +m[1],
              +m[2],
            ]);
            return pts.slice(1).map((q, k) => [pts[k], q]);
          });
          segs.forEach((A, ai) =>
            segs.forEach((B, bi) => {
              if (bi <= ai) return;
              if (
                paths[ai].dataset.from === paths[bi].dataset.from ||
                paths[ai].dataset.to === paths[bi].dataset.to
              )
                return;
              for (const [[x1, y1], [x2, y2]] of A)
                for (const [[u1, v1], [u2, v2]] of B) {
                  if ((y1 === y2) === (v1 === v2)) {
                    const [p1, p2, q1, q2, c, d] =
                      y1 === y2 ? [x1, x2, u1, u2, y1, v1] : [y1, y2, v1, v2, x1, u1];
                    if (
                      Math.abs(c - d) < 3 &&
                      Math.min(Math.max(p1, p2), Math.max(q1, q2)) -
                        Math.max(Math.min(p1, p2), Math.min(q1, q2)) >
                        2
                    )
                      out.push(`fig ${i}: arrows ${ai} and ${bi} run along one line`);
                    continue;
                  }
                  const [hx1, hx2, hy, vx, vy1, vy2] =
                    y1 === y2 ? [x1, x2, y1, u1, v1, v2] : [u1, u2, v1, x1, y1, y2];
                  if (
                    vx > Math.min(hx1, hx2) + 1 &&
                    vx < Math.max(hx1, hx2) - 1 &&
                    hy > Math.min(vy1, vy2) + 1 &&
                    hy < Math.max(vy1, vy2) - 1
                  )
                    out.push(`fig ${i}: arrows ${ai} and ${bi} cross`);
                }
            }),
          );
        }
        for (const head of fig.querySelectorAll(".alc-tree__head")) {
          const ws = [...head.children].map((c) => c.getBoundingClientRect());
          if (!ws.length) continue;
          const H = {
            left: Math.min(...ws.map((w) => w.left)) - 4,
            right: Math.max(...ws.map((w) => w.right)) + 4,
            top: Math.min(...ws.map((w) => w.top)),
            bottom: Math.max(...ws.map((w) => w.bottom)),
          };
          const root = fig.querySelector(".alc-tree").getBoundingClientRect();
          for (const p of fig.querySelectorAll(".alc-tree__link")) {
            const len = p.getTotalLength();
            for (let d = 0; d < len; d += 2) {
              const q = p.getPointAtLength(d);
              const x = q.x + root.left,
                y = q.y + root.top;
              if (x > H.left && x < H.right && y > H.top && y < H.bottom) {
                out.push(
                  `fig ${i}: an arrow runs through the heading "${head.textContent.trim()}"`,
                );
                break;
              }
            }
          }
        }
        for (const t of fig.querySelectorAll(
          ".alc-tree__label, .alc-tree__type, .alc-tree__specs",
        )) {
          const box = t.closest("[data-node]").getBoundingClientRect(),
            r = t.getBoundingClientRect();
          if (r.left < box.left - 1 || r.right > box.right + 1)
            out.push(`fig ${i}: "${t.textContent}" spills out of its box`);
        }
        {
          // A gutter is only worth its width if an arrow runs down it.
          const root = fig.querySelector(".alc-tree").getBoundingClientRect();
          const xs = [...fig.querySelectorAll(".alc-tree__link")].flatMap((p) =>
            [...p.getAttribute("d").matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map(
              (m) => +m[1] + root.left,
            ),
          );
          for (const k of fig.querySelectorAll(".alc-tree__kids--gutter")) {
            const kr = k.getBoundingClientRect();
            const first = Math.min(
              ...[...k.children]
                .filter((c) => c.dataset.node)
                .map((c) => c.getBoundingClientRect().left),
            );
            if (!xs.some((x) => x > kr.left && x < first - 1))
              out.push(`fig ${i}: an empty gutter`);
          }
          // Wasted room on the left: a container's children all start well inside it.
          for (const k of fig.querySelectorAll(".alc-tree__kids:not(.alc-tree__kids--gutter)")) {
            const cs = getComputedStyle(k);
            if (parseFloat(cs.paddingLeft) > 2)
              out.push(
                `fig ${i}: ${Math.round(parseFloat(cs.paddingLeft))}px of padding with no arrow in it`,
              );
          }
        }
        for (const el of fig.querySelectorAll("[data-node] [data-node]")) {
          const parent = el.parentElement.closest("[data-node]");
          const r = el.getBoundingClientRect(),
            q = parent.getBoundingClientRect();
          if (r.left < q.left - 1 || r.right > q.right + 1 || r.bottom > q.bottom + 1)
            out.push(`fig ${i}: ${el.dataset.node} sticks out of ${parent.dataset.node}`);
        }
        for (const p of fig.querySelectorAll(".alc-tree__link[data-blocked]"))
          out.push(`fig ${i}: a link has no clear route (${p.getAttribute("d")})`);
        for (const el of fig.querySelectorAll(".alc-tree *")) {
          const r = el.getBoundingClientRect();
          if (r.width && (r.right > panel.right + 1 || r.left < panel.left - 1))
            out.push(`fig ${i}: ${el.className || el.tagName} overflows panel`);
        }
      });
      return { out, n: figs.length };
    });
    for (const o of new Set(res.out)) problems.push(`${wname} ${p}: ${o}`);
    const figs = await page.$$("figure.alc-fig:has(.alc-tree)");
    for (let i = 0; i < figs.length; i++)
      await figs[i].screenshot({ path: `${out}/${wname}-${p.replaceAll("/", "_")}-${i}.png` });
  }
  await page.close();
}
await browser.close();
console.log(problems.join("\n") || "no problems");
