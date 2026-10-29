/**
 * This computer's own identity.
 *
 * MONSTER REBUILD (owner order): SPIRE is removed. The computer no longer asks a SPIRE agent for a
 * workload identity; authentication to the computer is the shared COMPUTER_TOKEN, and to the server
 * the service tokens. `identity()` always returns null so the /health contract keeps its shape.
 */

export type Identity = {
  spiffeId: string;
  /** How many identities this workload was issued, so an over-broad entry is visible rather than silent. */
  issued: number;
};

/** SPIRE is removed; there is no workload identity to report. */
export async function identity(): Promise<Identity | null> {
  return null;
}
