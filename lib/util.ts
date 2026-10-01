export function branchName(ref: string): string | undefined {
  const branchPrefix = 'refs/heads/';
  if (ref.startsWith(branchPrefix)) {
    return ref.slice(branchPrefix.length);
  }
}
