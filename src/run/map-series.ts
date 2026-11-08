export async function mapSeries<T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  return items.reduce<Promise<readonly R[]>>(async (accumulatorPromise, item) => {
    const accumulator = await accumulatorPromise;
    return [...accumulator, await run(item)];
  }, Promise.resolve([]));
}
