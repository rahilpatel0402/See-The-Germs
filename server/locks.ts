// Serializes work per clip so two requests for the same clip never both pay for the same model
// calls. The second caller waits for the first and then finds the cache.
const chains = new Map<string, Promise<unknown>>();

export async function withClipLock<T>(clipId: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(clipId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const guarded = run.catch(() => undefined);
  chains.set(clipId, guarded);
  try {
    return await run;
  } finally {
    // Only the last link in the chain removes the entry; an earlier link must leave the newer
    // promise in place for the callers queued behind it.
    if (chains.get(clipId) === guarded) chains.delete(clipId);
  }
}
