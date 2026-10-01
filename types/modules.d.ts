declare module 'object-resolve-path' {
  /**
   * Resolves a dot-separated path against an object, e.g.
   * `resolvePath({ user: { login: "a" } }, "user.login") === "a"`.
   */
  export default function resolvePath(obj: unknown, path: string): unknown;
}
