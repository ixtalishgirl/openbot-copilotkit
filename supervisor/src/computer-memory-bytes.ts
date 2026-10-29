/**
 * Docker memory cap for each computer, from `COMPUTER_MEMORY_BYTES`.
 *
 * Unset or empty (compose blank, leftover `.env` line) means the 8 GiB default. The same empty-string and
 * prefix traps as `listenPort`: `Number.parseInt("", 10)` is `NaN` (silently dropped) and
 * `Number.parseInt("512m", 10)` is `512` bytes, which Docker accepts and Chromium cannot live in.
 */
export function computerMemoryBytes(
  raw: string | undefined,
): { ok: true; bytes: number | undefined } | { ok: false; reason: string } {
  const trimmed = raw?.trim();
  // Explicit default: the fleet can hold up to 32 resident browsers, so the container gets a hard
  // 8 GiB cgroup cap even when the operator set nothing. This is the backstop for COMPUTER_MAX_BROWSERS.
  if (!trimmed) return { ok: true, bytes: 8_589_934_592 };
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      reason: `COMPUTER_MEMORY_BYTES must be a whole number of bytes (got ${JSON.stringify(raw)}).`,
    };
  }
  const value = Number.parseInt(trimmed, 10);
  if (value < 1) {
    return {
      ok: false,
      reason: `COMPUTER_MEMORY_BYTES must be a whole number of bytes (got ${JSON.stringify(raw)}).`,
    };
  }
  return { ok: true, bytes: value };
}
