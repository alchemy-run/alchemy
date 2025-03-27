export function slugify(str: string, delimiter = "-") {
  return str.toLowerCase().replace(/[^a-z0-9]/gi, delimiter);
}
