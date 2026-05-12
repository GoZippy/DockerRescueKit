import path from 'path'

/**
 * Resolve `rel` relative to `base` and guarantee the resolved path is still
 * inside `base`. Throws otherwise. Use for anything involving a filename
 * that could theoretically have been influenced by user input.
 */
export function safeJoin(base: string, ...rel: string[]): string {
  const resolvedBase = path.resolve(base)
  const resolved = path.resolve(resolvedBase, ...rel)
  const within = resolved === resolvedBase || resolved.startsWith(resolvedBase + path.sep)
  if (!within) {
    throw new Error(`Path escape attempt: ${rel.join('/')} resolves outside ${base}`)
  }
  return resolved
}

/**
 * Sanitize a fragment that will become a filename. Keeps a-z/A-Z/0-9/._-.
 */
export function safeFilenameFragment(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128)
}

/**
 * Validate a tar archive entry path supplied by an untrusted caller (e.g.
 * the HTTP layer). Throws if the path could be used to escape the archive's
 * logical root, inject CLI options, or smuggle null bytes.
 *
 * The returned string is a normalized POSIX path with any leading "./" or
 * "/" stripped. It is suitable for passing to `tar` as the entry to extract.
 *
 * Rejected:
 *   - empty string
 *   - null bytes
 *   - any ".." segment (anywhere in the path)
 *   - leading "-" (would be parsed as a CLI option)
 *   - absolute Windows paths like "C:\..." or "C:/..."
 *   - UNC paths like "\\server\share"
 *   - back-slashes (force POSIX-style entries; tar entries are POSIX)
 *   - excessively long paths (>1024 chars)
 */
export function assertSafeEntryPath(entryPath: string): string {
  if (typeof entryPath !== 'string' || entryPath.length === 0) {
    throw new Error('entryPath must be a non-empty string')
  }
  if (entryPath.length > 1024) {
    throw new Error('entryPath too long')
  }
  if (entryPath.includes('\0')) {
    throw new Error('entryPath contains null byte')
  }
  if (entryPath.includes('\\')) {
    throw new Error('entryPath must not contain back-slashes')
  }
  if (/^[a-zA-Z]:[\\/]/.test(entryPath)) {
    throw new Error('entryPath must not be an absolute Windows path')
  }
  if (entryPath.startsWith('/')) {
    throw new Error('entryPath must not be absolute (leading "/")')
  }
  // Strip a leading "./" — purely a normalization, not security.
  const cleaned = entryPath.replace(/^(?:\.\/)+/, '')
  if (cleaned.length === 0) {
    throw new Error('entryPath is empty after normalization')
  }
  if (cleaned.startsWith('/')) {
    throw new Error('entryPath must not be absolute after normalization')
  }
  if (cleaned.startsWith('-')) {
    throw new Error('entryPath must not start with "-"')
  }
  const segments = cleaned.split('/')
  for (const seg of segments) {
    if (seg === '..') {
      throw new Error('entryPath must not contain ".." segments')
    }
  }
  return cleaned
}
