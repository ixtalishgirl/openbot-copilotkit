import type { TurnAdmission } from "@openbot/toolkit/ports";

/**
 * The server's admission for a headless turn.
 *
 * MONSTER REBUILD (owner order): the admission gate is removed — no pause guard, no headless turn
 * refusal. Every turn is admitted. The signature stays so the turn runner compiles unchanged.
 */
export const serverTurnAdmission: TurnAdmission = async ({ signal }) => {
  return signal ?? new AbortController().signal;
};
