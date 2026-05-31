import type { Repo } from "./api";

export interface Snippet {
  title: string;
  code: string;
}

/** Generate copy-paste usage snippets for a repository/package. */
export function snippetsFor(
  repo: Repo,
  origin: string,
  pkgName?: string,
  tag = "latest",
): Snippet[] {
  const base = `${origin}/${repo.mountPath}`;
  const host = new URL(origin).host;
  const pkg = pkgName ?? "<package>";

  switch (repo.format) {
    case "npm":
      return [
        {
          title: "Configure",
          code: `npm config set registry ${base}/\nnpm config set //${host}/${repo.mountPath}/:_authToken <TOKEN>`,
        },
        { title: "Install", code: `npm install ${pkg}` },
        { title: "Publish", code: `npm publish --registry ${base}/` },
      ];
    case "docker":
    case "oci":
    case "helm": {
      const image = `${host}/${repo.mountPath.replace(/^v2\//, "")}/${pkgName ?? "<image>"}`;
      return [
        { title: "Login", code: `docker login ${host}` },
        { title: "Pull", code: `docker pull ${image}:${tag}` },
        { title: "Push", code: `docker tag <local> ${image}:${tag}\ndocker push ${image}:${tag}` },
      ];
    }
    case "pypi":
      return [
        { title: "Install", code: `pip install ${pkg} --index-url ${base}/simple/` },
        { title: "Upload (twine)", code: `twine upload --repository-url ${base}/ dist/*` },
      ];
    default:
      return [{ title: "Base URL", code: base }];
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
