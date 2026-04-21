export const CF_COLOR = "#F38020";
export const AWS_COLOR = "#2563EB";

export function tint(hex: string, a = 0.15): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}
