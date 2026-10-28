// Linear replacements for path regexes that backtrack quadratically on
// attacker-controlled input (CodeQL js/polynomial-redos). Keep these as plain
// index walks — reintroducing `/\/+$/` or `/([^/]+\/)$/` brings the DoS back.

/** Equivalent to `s.replace(/\/+$/, '')`. */
export function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f /* '/' */) end--;
  return s.slice(0, end);
}

/**
 * Trailing "<segment>/" of a prefix, or '' when the prefix has no trailing
 * slash or ends in an empty segment ("//", "/"). Equivalent to
 * `s.match(/([^/]+\/)$/)?.[1] ?? ''`.
 */
export function lastPathSegment(prefix: string): string {
  if (!prefix.endsWith('/')) return '';
  const lastSlash = prefix.length - 1;
  const start = prefix.lastIndexOf('/', lastSlash - 1) + 1;
  if (start >= lastSlash) return '';
  return prefix.slice(start);
}
