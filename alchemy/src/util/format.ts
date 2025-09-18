const byteUnits = ["bytes", "KB", "MB", "GB", "TB", "PB"] as const;
export function formatBytes(bytes: number, unit?: (typeof byteUnits)[number]) {
  let index = Math.floor(Math.log(bytes) / Math.log(1024));
  if (unit) {
    index = byteUnits.indexOf(unit);
  }
  return `${(bytes / 1024 ** index).toFixed(2).replace(".00", "")} ${byteUnits[index]}`;
}
