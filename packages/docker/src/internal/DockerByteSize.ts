/**
 * Docker's go-units `RAMInBytes` grammar, shared by Dockerfile mount-size
 * validation and Docker CLI byte-size options. Zero is syntactically valid;
 * callers may require strictly positive sizes.
 */
export const isDockerByteSize = (value: string): boolean => {
  const sep = Math.max(...Array.from("01234567890. ", (c) => value.lastIndexOf(c)));
  if (sep === -1) return false;
  const num = value[sep] === " " ? value.slice(0, sep) : value.slice(0, sep + 1);
  const suffix = value.slice(sep + 1).toLowerCase();
  if (!/^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(num)) return false;
  if (Number(num) < 0) return false;
  if (suffix === "") return true;
  if (suffix.length > 3) return false;
  if (suffix[0] === "b") return suffix.length === 1;
  if (!"kmgtp".includes(suffix[0]!)) return false;
  return (
    suffix.length === 1 || (suffix.length === 2 ? suffix[1] === "b" : suffix.slice(1) === "ib")
  );
};
