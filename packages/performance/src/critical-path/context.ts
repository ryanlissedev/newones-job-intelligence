import { AsyncLocalStorage } from "node:async_hooks";

import type { CriticalPathLabel } from "../labels";
import type { CriticalPathSession } from "./session";

export const criticalPathStorage = new AsyncLocalStorage<CriticalPathSession>();

export const currentCriticalPathSession = (): CriticalPathSession | undefined =>
  criticalPathStorage.getStore();

export const withCriticalPathSession = <Result>(
  session: CriticalPathSession,
  operation: () => Promise<Result>
): Promise<Result> => criticalPathStorage.run(session, operation);

export const timeCriticalPathPhase = <Result>(
  label: CriticalPathLabel,
  operation: () => Promise<Result>
): Promise<Result> => {
  const session = criticalPathStorage.getStore();
  if (session === undefined) {
    return operation();
  }
  return session.timePhase(label, operation);
};

export const recordCriticalPathPhaseSync = <Result>(
  label: CriticalPathLabel,
  operation: () => Result
): Result => {
  const session = criticalPathStorage.getStore();
  if (session === undefined) {
    return operation();
  }
  return session.timePhaseSync(label, operation);
};
