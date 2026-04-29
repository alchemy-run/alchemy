/**
 * Downloads the static (non-variable) TTFs for our brand fonts into
 * `website/assets/fonts/` so the OG image renderer (satori) has complete
 * Unicode coverage — arrows, em-dashes, fancy quotes, etc.
 *
 * Why static, not variable: satori's opentype parser
 * (`@shuding/opentype.js`) can't parse Google Fonts' variable TTFs (the
 * ones with `[opsz,wght]` axes). Static TTFs work fine and the upstream
 * static releases include the full glyph set unlike the `@fontsource/*`
 * woff packages, which are subsetted to `latin` only and miss arrows.
 *
 * Files are cached on disk; subsequent runs are no-ops unless missing.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fontsDir = path.resolve(here, "../assets/fonts");

interface FontSource {
  file: string;
  url: string;
}

const FONTS: FontSource[] = [
  // Source Serif 4 — Adobe's official static TTFs.
  //
  // Two optical-size variants: Display (chunkier serifs, more stroke
  // contrast) for the headline at ~100px, and Text (calmer, more even
  // weight) for the description at ~26px. The website's hero uses the
  // variable font which auto-selects optical size; satori needs us to
  // pick explicitly per element.
  {
    file: "SourceSerif4-Regular.ttf",
    url: "https://cdn.jsdelivr.net/gh/adobe-fonts/source-serif@release/TTF/SourceSerif4-Regular.ttf",
  },
  {
    file: "SourceSerif4-It.ttf",
    url: "https://cdn.jsdelivr.net/gh/adobe-fonts/source-serif@release/TTF/SourceSerif4-It.ttf",
  },
  {
    file: "SourceSerif4Display-Regular.ttf",
    url: "https://cdn.jsdelivr.net/gh/adobe-fonts/source-serif@release/TTF/SourceSerif4Display-Regular.ttf",
  },
  {
    file: "SourceSerif4Display-It.ttf",
    url: "https://cdn.jsdelivr.net/gh/adobe-fonts/source-serif@release/TTF/SourceSerif4Display-It.ttf",
  },
  {
    file: "SourceSerif4Display-Light.ttf",
    url: "https://cdn.jsdelivr.net/gh/adobe-fonts/source-serif@release/TTF/SourceSerif4Display-Light.ttf",
  },
  {
    file: "SourceSerif4Display-LightIt.ttf",
    url: "https://cdn.jsdelivr.net/gh/adobe-fonts/source-serif@release/TTF/SourceSerif4Display-LightIt.ttf",
  },

  // JetBrains Mono — for the eyebrow label.
  {
    file: "JetBrainsMono-Regular.ttf",
    url: "https://cdn.jsdelivr.net/gh/JetBrains/JetBrainsMono@v2.304/fonts/ttf/JetBrainsMono-Regular.ttf",
  },

  // Caveat — for the hand-drawn alchemy.run URL stamp.
  {
    file: "Caveat-Regular.ttf",
    url: "https://cdn.jsdelivr.net/gh/googlefonts/caveat@main/fonts/ttf/Caveat-Regular.ttf",
  },
];

async function exists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.size > 1024;
  } catch {
    return false;
  }
}

async function downloadOne(font: FontSource): Promise<"cached" | "fetched"> {
  const dest = path.join(fontsDir, font.file);
  if (await exists(dest)) return "cached";

  const res = await fetch(font.url);
  if (!res.ok) {
    throw new Error(
      `Failed to download ${font.file} from ${font.url}: ${res.status} ${res.statusText}`,
    );
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength < 1024) {
    throw new Error(
      `Suspiciously small download for ${font.file} (${buf.byteLength} bytes) — bad URL?`,
    );
  }
  await writeFile(dest, buf);
  return "fetched";
}

async function main() {
  await mkdir(fontsDir, { recursive: true });
  const results = await Promise.all(FONTS.map(downloadOne));
  const fetched = results.filter((r) => r === "fetched").length;
  const cached = results.filter((r) => r === "cached").length;
  console.log(`[fonts] ${fetched} downloaded, ${cached} cached → ${fontsDir}`);
}

await main();
