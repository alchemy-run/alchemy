import crypto from "crypto";
import { promises as fs } from "fs";
import { glob } from "glob";
import path from "path";
import { getContentType } from "../utils/content-type";
import type {
  AssetManifest,
  AssetManifestEntry,
  FileOption,
} from "./asset-manifest";

export async function generateAssetManifest(
  dir: string,
  fileOptions: FileOption[] = [
    {
      files: "**",
      cacheControl: "max-age=0,no-cache,no-store,must-revalidate",
    },
    {
      files: ["**/*.js", "**/*.css"],
      cacheControl: "max-age=31536000,public,immutable",
    },
  ],
): Promise<AssetManifest> {
  // First, collect all file info based on fileOptions (reversed to prioritize later rules)
  const fileInfos: Array<{
    file: string;
    cacheControl: string;
    contentType?: string;
  }> = [];
  const filesProcessed: Set<string> = new Set();

  // Process file options in reverse order (later rules override earlier ones)
  // Use for...of to maintain order but allow await inside the loop
  const reversedOptions = [...fileOptions].reverse();
  for (const fileOption of reversedOptions) {
    const patterns = Array.isArray(fileOption.files)
      ? fileOption.files
      : [fileOption.files];

    // Get all files matching the pattern
    const files = (
      await Promise.all(
        patterns.map(async (p) => {
          // Use glob as async function instead of globSync
          return glob(p, {
            cwd: path.resolve(dir),
            nodir: true,
            dot: true,
            ignore: [
              ".git/**",
              "node_modules/**",
              ...(typeof fileOption.ignore === "string"
                ? [fileOption.ignore]
                : (fileOption.ignore ?? [])),
            ],
          });
        }),
      )
    )
      .flat()
      .filter((file) => !filesProcessed.has(file));

    // Add files to processed set
    for (const file of files) {
      filesProcessed.add(file);
      fileInfos.push({
        file,
        cacheControl: fileOption.cacheControl,
        contentType: fileOption.contentType,
      });
    }
  }

  // Process all files in parallel
  const manifestEntries = await Promise.all(
    fileInfos.map(async ({ file, cacheControl, contentType }) => {
      const source = path.resolve(dir, file);
      const content = await fs.readFile(source);
      const hash = crypto.createHash("sha256").update(content).digest("hex");

      return {
        source,
        key: file,
        hash,
        cacheControl,
        contentType: contentType ?? getContentType(file),
      } satisfies AssetManifestEntry;
    }),
  );

  return manifestEntries;
}
