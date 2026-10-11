/** An invalid session must not prevent explicit removal of the instance record. */
export async function removeInstanceSession(operations: {
  logout: () => Promise<unknown>;
  remove: () => Promise<unknown>;
  onLogoutError: (error: unknown) => void;
}) {
  try {
    await operations.logout();
  } catch (error) {
    operations.onLogoutError(error);
  }
  // Propagate persistence failures: never acknowledge a partial deletion.
  await operations.remove();
}
