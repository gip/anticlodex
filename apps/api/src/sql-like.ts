// `%` and `_` are wildcards inside LIKE/ILIKE, so a search box that passes user
// input straight through turns a typed "%" into "match every row". Escaping is
// only half of it: the query must also declare the escape character, since
// Postgres has no default one.
export const SQL_LIKE_ESCAPE_CHARACTER = "\\";

export function toLikeContainsPattern(search: string): string {
  const escaped = search.replace(
    /[\\%_]/g,
    (character) => `${SQL_LIKE_ESCAPE_CHARACTER}${character}`,
  );
  return `%${escaped}%`;
}
