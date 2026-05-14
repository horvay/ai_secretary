let turnSeq = 0;
let activeTurnId: string | null = null;
let activeTurnFinalizer: ((reason: string) => void) | null = null;

export function nextTurnId(): string {
  turnSeq += 1;
  return `turn_${Date.now()}_${turnSeq}`;
}

export function getActiveTurnId(): string | null {
  return activeTurnId;
}

export function setActiveTurnId(turnId: string | null): void {
  activeTurnId = turnId;
}

export function isActiveTurn(turnId: string): boolean {
  return activeTurnId === turnId;
}

export function clearActiveTurnIfCurrent(turnId: string): void {
  if (activeTurnId === turnId) activeTurnId = null;
}

export function setActiveTurnFinalizer(finalizer: ((reason: string) => void) | null): void {
  activeTurnFinalizer = finalizer;
}

export function clearActiveTurnFinalizer(): void {
  activeTurnFinalizer = null;
}

export function finalizeActiveTurn(reason: string): void {
  activeTurnFinalizer?.(reason);
  activeTurnFinalizer = null;
}
