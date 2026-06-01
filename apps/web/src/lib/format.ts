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
    case "oci": {
      const image = `${host}/${repo.mountPath.replace(/^v2\//, "")}/${pkgName ?? "<image>"}`;
      return [
        { title: "Login", code: `docker login ${host}` },
        { title: "Pull", code: `docker pull ${image}:${tag}` },
        { title: "Push", code: `docker tag <local> ${image}:${tag}\ndocker push ${image}:${tag}` },
      ];
    }
    case "helm": {
      const chartRoot = `${host}/${repo.mountPath.replace(/^v2\//, "")}`;
      const chart = pkgName ?? "<chart>";
      return [
        { title: "Login", code: `helm registry login ${host}` },
        { title: "Pull", code: `helm pull oci://${chartRoot}/${chart} --version ${tag}` },
        { title: "Push", code: `helm push <chart.tgz> oci://${chartRoot}` },
      ];
    }
    case "pypi":
      return [
        { title: "Install", code: `pip install ${pkg} --index-url ${base}/simple/` },
        { title: "Upload (twine)", code: `twine upload --repository-url ${base}/legacy/ dist/*` },
      ];
    case "go":
      return [
        { title: "Configure", code: `go env -w GOPROXY=${base}\ngo env -w GOSUMDB=off` },
        { title: "Download", code: `go mod download ${pkg}@${tag}` },
        {
          title: "Upload",
          code: `curl -u <USER>:<TOKEN> -F mod=@go.mod -F zip=@module.zip ${base}/${pkg}/@v/${tag}`,
        },
      ];
    case "cargo":
      return [
        {
          title: "Configure",
          code: `[registries.hooti]\nindex = "sparse+${base}/"\n\nexport CARGO_REGISTRIES_HOOTI_TOKEN=<TOKEN>`,
        },
        { title: "Install", code: `cargo add ${pkg} --registry hooti` },
        { title: "Publish", code: `cargo publish --registry hooti` },
      ];
    case "nuget":
      return [
        {
          title: "Configure",
          code: `dotnet nuget add source ${base}/v3/index.json --name hooti --username hooti --password <TOKEN> --store-password-in-clear-text`,
        },
        { title: "Install", code: `dotnet add package ${pkg} --source ${base}/v3/index.json` },
        {
          title: "Push",
          code: `dotnet nuget push <package.nupkg> --api-key <TOKEN> --source ${base}/v3/index.json`,
        },
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
