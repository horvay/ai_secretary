import type { AvatarState } from "../components/Avatar";

interface RemoteStatePayload {
  state: AvatarState;
  turnId?: string;
  reason?: string;
}

interface RemoteFollowupPayload {
  turnId?: string;
  reason?: string;
}

interface TurnControllerDeps {
  onApplyState: (payload: RemoteStatePayload) => void;
  onActivateFollowup: (payload: RemoteFollowupPayload) => void;
  logDebug: (message: string, ...args: unknown[]) => void;
}

export interface TurnController {
  handleRemoteState: (payload: RemoteStatePayload) => void;
  handleRemoteFollowup: (payload: RemoteFollowupPayload) => void;
  clearActiveTurn: (reason: string) => void;
  getActiveTurnId: () => string | null;
}

export function createTurnController({
  onApplyState,
  onActivateFollowup,
  logDebug,
}: TurnControllerDeps): TurnController {
  let activeTurnId: string | null = null;

  function shouldAcceptTurnEvent(turnId?: string): boolean {
    if (!turnId) return true;
    if (!activeTurnId) return true;
    return activeTurnId === turnId;
  }

  function handleRemoteState(payload: RemoteStatePayload): void {
    const { state, turnId, reason } = payload;

    if (state === "processing" && turnId) {
      activeTurnId = turnId;
    }

    if (!shouldAcceptTurnEvent(turnId)) {
      logDebug(
        `[TurnController] Ignoring stale state event state=${state}, turnId=${turnId}, activeTurnId=${activeTurnId}, reason=${reason}`,
      );
      return;
    }

    if (turnId && !activeTurnId) {
      activeTurnId = turnId;
    }

    onApplyState(payload);
  }

  function handleRemoteFollowup(payload: RemoteFollowupPayload): void {
    const { turnId, reason } = payload;
    if (!shouldAcceptTurnEvent(turnId)) {
      logDebug(
        `[TurnController] Ignoring stale followup event turnId=${turnId}, activeTurnId=${activeTurnId}, reason=${reason}`,
      );
      return;
    }
    onActivateFollowup(payload);
  }

  function clearActiveTurn(reason: string): void {
    logDebug(`[TurnController] Clearing active turn (reason=${reason}, turnId=${activeTurnId})`);
    activeTurnId = null;
  }

  return {
    handleRemoteState,
    handleRemoteFollowup,
    clearActiveTurn,
    getActiveTurnId: () => activeTurnId,
  };
}
