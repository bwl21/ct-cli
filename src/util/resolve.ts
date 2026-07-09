/**
 * Shared precedence for a path/dir setting: an explicit flag wins, else an
 * environment value, else a hardcoded fallback. Whitespace-only values are
 * treated as unset (a bare `--flag ""` or `VAR=" "` falls through). Used by
 * every `resolve<Config|State|BackupDir>` helper so the idiom lives once.
 */
export function resolveWithEnv(
  explicit: string | undefined,
  envValue: string | undefined,
  fallback: string,
): string {
  return explicit?.trim() || envValue?.trim() || fallback;
}
