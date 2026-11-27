/**
 * A tar archive of regular files, in the order given, for tests. `"gnu"`
 * writes old-GNU headers, whose magic is `ustar  ` and whose bytes 345 on
 * hold access and change times rather than a name prefix.
 */
export const tarArchive = (
  entries: ReadonlyArray<{ name: string; data: Uint8Array }>,
  format: "ustar" | "gnu" = "ustar",
) => {
  const blocks: Uint8Array[] = [];
  for (const { name, data } of entries) {
    const header = new Uint8Array(512);
    const put = (text: string, offset: number) =>
      header.set(new TextEncoder().encode(text), offset);
    put(name, 0);
    put("0000644\0", 100);
    put("0000000\0", 108);
    put("0000000\0", 116);
    put(`${data.byteLength.toString(8).padStart(11, "0")}\0`, 124);
    put("00000000000\0", 136);
    put("        ", 148);
    put("0", 156);
    if (format === "ustar") {
      put("ustar\u000000", 257);
    } else {
      put("ustar  \0", 257);
      put("14712345670\0", 345);
      put("14712345670\0", 357);
    }
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    put(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, new Uint8Array((512 - (data.byteLength % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const archive = new Uint8Array(blocks.reduce((size, block) => size + block.byteLength, 0));
  let offset = 0;
  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.byteLength;
  }
  return archive;
};
