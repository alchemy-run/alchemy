const byteUnits = [
  "bytes",
  "KB",
  "MB",
  "GB",
  "TB",
  "PB",
  // These are too large for most practical use cases and exceed Number.MAX_SAFE_INTEGER
  // "EB",
  // "ZB",
  // "YB",
] as const;

export function formatBytes(bytes: number, unit?: (typeof byteUnits)[number]) {
  let index = Math.floor(Math.log(bytes) / Math.log(1024));
  if (unit) {
    index = byteUnits.indexOf(unit);
  }
  return `${(bytes / 1024 ** index).toFixed(2).replace(".00", "")} ${byteUnits[index]}`;
}

export function parseBytes(bytes: string) {
  let [, value, unit] = /(\d+(?:\.\d+)?)\s*(\w+)/.exec(bytes) ?? [];
  if (!unit) {
    return Number(value);
  }
  unit = unit.toUpperCase();
  if (unit[0] === "B") {
    unit = "bytes";
  }
  const index = byteUnits.indexOf(unit as (typeof byteUnits)[number]);
  return Number(value) * 1024 ** index;
}
