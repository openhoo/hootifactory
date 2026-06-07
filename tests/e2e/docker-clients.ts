import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI_IMAGES = {
  alpine: process.env.E2E_ALPINE_IMAGE ?? "alpine:3.20",
  ansible: process.env.E2E_ANSIBLE_IMAGE ?? "geerlingguy/docker-ubuntu2404-ansible:latest",
  apt: process.env.E2E_APT_IMAGE ?? "debian:12",
  arch: process.env.E2E_ARCH_IMAGE ?? "archlinux:latest",
  cargo: process.env.E2E_CARGO_IMAGE ?? "rust:1.85-bookworm",
  composer: process.env.E2E_COMPOSER_IMAGE ?? "composer:2",
  conan: process.env.E2E_CONAN_IMAGE ?? "conanio/gcc11:latest",
  conda: process.env.E2E_CONDA_IMAGE ?? "mambaorg/micromamba:latest",
  cran: process.env.E2E_CRAN_IMAGE ?? "r-base:4.4.1",
  dart: process.env.E2E_DART_IMAGE ?? "dart:stable",
  docker: process.env.E2E_DOCKER_IMAGE ?? "docker:28-cli",
  dotnet: process.env.E2E_DOTNET_IMAGE ?? "mcr.microsoft.com/dotnet/sdk:9.0",
  go: process.env.E2E_GO_IMAGE ?? "golang:1.24-bookworm",
  helm: process.env.E2E_HELM_IMAGE ?? "alpine/helm:3.19.0",
  homebrew: process.env.E2E_HOMEBREW_IMAGE ?? "homebrew/brew:latest",
  luarocks: process.env.E2E_LUAROCKS_IMAGE ?? "nickblah/lua:5.4-luarocks",
  maven: process.env.E2E_MAVEN_IMAGE ?? "maven:3.9-eclipse-temurin-21",
  nix: process.env.E2E_NIX_IMAGE ?? "nixos/nix:2.24.9",
  node: process.env.E2E_NODE_IMAGE ?? "node:22-bookworm-slim",
  opam: process.env.E2E_OPAM_IMAGE ?? "ocaml/opam:debian-12-ocaml-5.2",
  oras: process.env.E2E_ORAS_IMAGE ?? "ghcr.io/oras-project/oras:v1.3.0",
  puppet: process.env.E2E_PUPPET_IMAGE ?? "puppet/puppet-agent:7.20.0",
  rpm: process.env.E2E_RPM_IMAGE ?? "rockylinux:9",
  ruby: process.env.E2E_RUBY_IMAGE ?? "ruby:3.3-bookworm",
  swift: process.env.E2E_SWIFT_IMAGE ?? "swift:6.0",
};

const E2E_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Client images we build on first use from a `fixtures/<key>-client.Dockerfile`,
 * because no widely-available image ships the tool ready to run (python+twine,
 * curl on a debian base, cocoapods, git-lfs). An `E2E_<KEY>_IMAGE` env override
 * pins a prebuilt image and skips the build.
 */
const BUILT_CLIENT_IMAGES = {
  python: process.env.E2E_PYTHON_IMAGE ?? "hootifactory/e2e-python-client:local",
  curl: process.env.E2E_CURL_IMAGE ?? "hootifactory/e2e-curl-client:local",
  cocoapods: process.env.E2E_COCOAPODS_IMAGE ?? "hootifactory/e2e-cocoapods-client:local",
  gitlfs: process.env.E2E_GITLFS_IMAGE ?? "hootifactory/e2e-gitlfs-client:local",
  // No widely-available Docker Hub image ships `knife` (chef) or the `vagrant` CLI.
  chef: process.env.E2E_CHEF_IMAGE ?? "hootifactory/e2e-chef-client:local",
  vagrant: process.env.E2E_VAGRANT_IMAGE ?? "hootifactory/e2e-vagrant-client:local",
  // sbt pre-warmed with scala-library so the Ivy e2e resolves scala offline.
  ivy: process.env.E2E_IVY_IMAGE ?? "hootifactory/e2e-ivy-client:local",
} as const;
export type BuiltClientKey = keyof typeof BUILT_CLIENT_IMAGES;
const builtClientReady = new Set<string>(
  (Object.keys(BUILT_CLIENT_IMAGES) as BuiltClientKey[])
    .filter((key) => process.env[`E2E_${key.toUpperCase()}_IMAGE`])
    .map((key) => BUILT_CLIENT_IMAGES[key]),
);

export interface DockerRunOptions {
  cwd?: string;
  dockerSocket?: boolean;
  entrypoint?: string;
  env?: Record<string, string | undefined>;
  input?: string;
  mounts?: string[];
  user?: "host" | "root";
  /**
   * Hard wall-clock cap (ms). `execFileSync` is synchronous, so a hung container
   * would otherwise block the Playwright worker indefinitely (the per-test
   * timeout cannot interrupt a sync syscall). On timeout the `docker run` process
   * is SIGKILLed and the call throws. Defaults to 5 minutes.
   */
  timeout?: number;
}

function hostUser(): string | null {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return null;
  return `${process.getuid()}:${process.getgid()}`;
}

function mountArgs(path: string): string[] {
  return ["--mount", `type=bind,source=${path},target=${path}`];
}

export function ensureDockerAvailable(): void {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
  } catch {
    throw new Error("Docker daemon is required for Docker-backed real-client e2e tests");
  }
}

export function dockerReachableUrl(baseURL: string): string {
  const url = new URL(baseURL);
  if (process.platform !== "linux" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    url.hostname = "host.docker.internal";
  }
  return url.toString().replace(/\/$/, "");
}

export function dockerRun(
  image: string,
  args: string[],
  {
    cwd = tmpdir(),
    dockerSocket = false,
    entrypoint,
    env = {},
    input,
    mounts = [],
    user = "host",
    timeout = 300_000,
  }: DockerRunOptions = {},
): string {
  const dockerArgs = ["run", "--rm", "--pull", "missing"];
  if (input !== undefined) dockerArgs.push("--interactive");
  if (process.platform === "linux") {
    dockerArgs.push("--network", "host");
  } else {
    dockerArgs.push("--add-host", "host.docker.internal:host-gateway");
  }

  const hostTmp = tmpdir();
  const bindMounts = new Set([hostTmp, ...mounts]);
  if (!cwd.startsWith(`${hostTmp}/`) && cwd !== hostTmp) bindMounts.add(cwd);
  for (const mount of bindMounts) dockerArgs.push(...mountArgs(mount));

  if (dockerSocket) {
    const socket = "/var/run/docker.sock";
    if (!existsSync(socket)) throw new Error(`${socket} is required for Docker CLI e2e tests`);
    dockerArgs.push(...mountArgs(socket), "--env", "DOCKER_HOST=unix:///var/run/docker.sock");
    if (user === "host") dockerArgs.push("--group-add", String(statSync(socket).gid));
  }

  const uid = hostUser();
  if (user === "host" && uid) dockerArgs.push("--user", uid);
  if (entrypoint) dockerArgs.push("--entrypoint", entrypoint);
  dockerArgs.push("--workdir", cwd);

  const mergedEnv = { HOME: cwd, ...env };
  for (const [key, value] of Object.entries(mergedEnv)) {
    if (value !== undefined) dockerArgs.push("--env", `${key}=${value}`);
  }

  dockerArgs.push(image, ...args);

  try {
    return execFileSync("docker", dockerArgs, {
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; signal?: string };
    const timedOut = e.signal === "SIGKILL" ? ` (timed out after ${timeout}ms)` : "";
    throw new Error(
      `docker run ${image} ${args.join(" ")} failed${timedOut}:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`,
    );
  }
}

export function dockerNpm(args: string[], cwd: string): string {
  return dockerRun(CLI_IMAGES.node, ["npm", ...args], {
    cwd,
    env: {
      npm_config_cache: join(cwd, ".npm-cache"),
      npm_config_update_notifier: "false",
    },
  });
}

/**
 * Resolve a lazily-built client image, building it from its fixtures Dockerfile
 * on first use if it is not already present locally. Subsequent calls (and runs
 * with the image cached) are no-ops.
 */
export function builtClientImage(key: BuiltClientKey): string {
  const image = BUILT_CLIENT_IMAGES[key];
  if (builtClientReady.has(image)) return image;
  ensureDockerAvailable();
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
  } catch {
    const dockerfile = join(E2E_DIR, "fixtures", `${key}-client.Dockerfile`);
    try {
      execFileSync(
        "docker",
        ["build", "--pull", "-f", dockerfile, "-t", image, dirname(dockerfile)],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(`failed to build ${image}:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`);
    }
  }
  builtClientReady.add(image);
  return image;
}

/** The python+twine client image (built from fixtures/python-client.Dockerfile). */
export function pythonClientImage(): string {
  return builtClientImage("python");
}
