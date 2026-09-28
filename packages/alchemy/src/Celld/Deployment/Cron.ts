const months = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const integer = (text: string, min: number, max: number) =>
  /^\d+$/.test(text) && Number(text) >= min && Number(text) <= max;
const value = (
  text: string,
  min: number,
  max: number,
  names: readonly string[],
) => {
  const named = names.indexOf(text.toLowerCase());
  return named >= 0
    ? min + named
    : integer(text, min, max)
      ? Number(text)
      : undefined;
};
const field = (
  text: string,
  min: number,
  max: number,
  names: readonly string[] = [],
) => {
  const items = text.split(",");
  return items.every((item) => {
    if (items.length > 1 && item === "*") return false;
    const parts = item.split("/");
    if (
      parts.length > 2 ||
      (parts[1] !== undefined && !integer(parts[1], 1, max - min))
    )
      return false;
    const spec = parts[0]!;
    if (spec === "*") return true;
    const range = spec.split("-");
    if (range.length > 2) return false;
    const first = value(range[0]!, min, max, names);
    const last = range.length === 2 ? value(range[1]!, min, max, names) : first;
    return first !== undefined && last !== undefined && first <= last;
  });
};

/** Validation grammar from celld v0.5 crates/logic/cron.rs, including 1–7 weekdays. */
export const validCron = (expression: string) => {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, day, month, weekday] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const dom =
    day === "L" ||
    day === "LW" ||
    (/^L-\d+W?$/.test(day) && integer(day.slice(2).replace(/W$/, ""), 1, 30)) ||
    (/^\d+W$/.test(day) && integer(day.slice(0, -1), 1, 31)) ||
    field(day, 1, 31);
  const nth = weekday.split("#");
  const dow =
    weekday === "L" ||
    (weekday.endsWith("L") &&
      value(weekday.slice(0, -1), 1, 7, weekdays) !== undefined) ||
    (nth.length === 2 &&
      value(nth[0]!, 1, 7, weekdays) !== undefined &&
      integer(nth[1]!, 1, 5)) ||
    field(weekday, 1, 7, weekdays);
  return (
    field(minute!, 0, 59) &&
    field(hour!, 0, 23) &&
    dom &&
    field(month!, 1, 12, months) &&
    dow
  );
};
