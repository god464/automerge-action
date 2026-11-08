export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function mapResult<T, U, E>(result: Result<T, E>, map: (value: T) => U): Result<U, E> {
  return result.ok ? ok(map(result.value)) : result;
}

export function flatMapResult<T, U, E>(
  result: Result<T, E>,
  map: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? map(result.value) : result;
}

export function collectResults<T, E>(
  results: readonly Result<T, E>[],
): Result<readonly T[], readonly E[]> {
  const collected = results.reduce<{
    readonly values: readonly T[];
    readonly errors: readonly E[];
  }>(
    (accumulator, result) =>
      result.ok
        ? { values: [...accumulator.values, result.value], errors: accumulator.errors }
        : { values: accumulator.values, errors: [...accumulator.errors, result.error] },
    { values: [], errors: [] },
  );

  return collected.errors.length === 0 ? ok(collected.values) : err(collected.errors);
}

export function pipe<A>(value: A): A;
export function pipe<A, B>(value: A, ab: (value: A) => B): B;
export function pipe<A, B, C>(value: A, ab: (value: A) => B, bc: (value: B) => C): C;
export function pipe<A, B, C, D>(
  value: A,
  ab: (value: A) => B,
  bc: (value: B) => C,
  cd: (value: C) => D,
): D;
export function pipe<A, B, C, D, E>(
  value: A,
  ab: (value: A) => B,
  bc: (value: B) => C,
  cd: (value: C) => D,
  de: (value: D) => E,
): E;
export function pipe(
  value: unknown,
  ...functions: readonly ((input: never) => unknown)[]
): unknown {
  return functions.reduce<unknown>(
    (accumulator, transform) => transform(accumulator as never),
    value,
  );
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
