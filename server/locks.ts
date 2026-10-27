// Serializes work per clip so two requests for the same clip never both pay for the same model
// calls. The second caller waits for the first and then finds the cache.
const chains = new Map<string, Promise<unknown>>();

export async function withClipLock<T>(clipId: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(clipId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  chains.set(clipId, run.catch(() => undefined));
  try {
    return await run;
  } finally {
    if (chains.get(clipId) === run.catch(() => undefined)) chains.delete(clipId);
  }
}
