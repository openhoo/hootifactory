import type { Repo } from "./api";

export interface Snippet {
  title: string;
  code: string;
}

export function snippetsFor(repo: Repo, origin: string): Snippet[] {
  return [{ title: "Base URL", code: `${origin}/${repo.mountPath}` }];
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
