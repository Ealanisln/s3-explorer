// macOS/Windows-style auto-rename: `name.ext` → `name (1).ext` →
// `name (2).ext` … until the candidate isn't in the `taken` set.
//
// Edge cases:
//   - No extension: `README` → `README (1)`
//   - Hidden file (leading dot): `.htaccess` → `.htaccess (1)` (Finder
//     treats it as extension-less).
//   - Compound ext (`archive.tar.gz`): splits at the LAST dot →
//     `archive.tar (1).gz`. Matches Finder behavior.
//   - Already-suffixed name (`foo (3).pdf`): bump from there →
//     `foo (4).pdf`, not `foo (3) (1).pdf`.
//
// The `taken` set should include both existing destination keys (minus
// the prefix — we work in name space here) AND any names already assigned
// to earlier files in this same batch.
export function nextFreeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const m = base.match(/^(.+) \((\d+)\)$/);
  const stem = m ? m[1] : base;
  let n = m ? parseInt(m[2], 10) + 1 : 1;
  let candidate = `${stem} (${n})${ext}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${stem} (${n})${ext}`;
  }
  return candidate;
}
