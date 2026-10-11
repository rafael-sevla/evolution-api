/** An invalid session must not prevent explicit removal of the instance record. */
export async function removeInstanceSession(operations: {
  logout: () => Promise<unknown>;
  remove: () => Promise<unknown>;
  onLogoutError: (error: unknown) => void;
  logoutTimeoutMs?: number;
}) {
  const timeoutMs = operations.logoutTimeoutMs ?? 5000;
  let timeout: NodeJS.Timeout;
  try {
    await Promise.race([
      operations.logout(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Logout timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    operations.onLogoutError(error);
  } finally {
    clearTimeout(timeout);
  }
  // Propagate persistence failures: never acknowledge a partial deletion.
  await operations.remove();
}

/** Lifecycle notifications must never hold up explicit session persistence. */
export function dispatchInstanceLifecycleEvent(
  operation: () => Promise<unknown>,
  onError: (error: unknown) => void,
): void {
  try {
    void operation().catch(onError);
  } catch (error) {
    onError(error);
  }
}
