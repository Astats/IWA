/** Drops keys whose value is `undefined`, so a parsed partial patch never overwrites fields. */
export function definedOnly<T extends object>(
  patch: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
