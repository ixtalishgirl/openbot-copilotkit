import type { ComputerNames } from "./names";

/**
 * A SPIFFE identity for each Bot's computer.
 *
 * MONSTER REBUILD (owner order): SPIRE is removed. Computers authenticate with the shared
 * COMPUTER_TOKEN; the supervisor no longer registers workload entries. `registerEntry` always
 * reports unregistered so callers keep their shape.
 */

export function spiffeIdFor(botId: string): string {
  return `spiffe://openbot.local/bot/${botId}`;
}

export type EntryResult =
  | { registered: true; spiffeId: string }
  | { registered: false; reason: string };

/** SPIRE is removed; computers are never registered. */
export async function registerEntry(
  _names: ComputerNames,
): Promise<EntryResult> {
  return { registered: false, reason: "SPIRE is removed (MONSTER rebuild)." };
}
