import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI_IMAGES = {
  cargo: process.env.E2E_CARGO_IMAGE ?? "rust:1.85-bookworm",
  composer: process.env.E2E_COMPOSER_IMAGE ?? "composer:2",
  docker: process.env.E2E_DOCKER_IMAGE ?? "docker:28-cli",
  dotnet: process.env.E2E_DOTNET_IMAGE ?? "mcr.microsoft.com/dotnet/sdk:9.0",
  go: process.env.E2E_GO_IMAGE ?? "golang:1.24-bookworm",
  helm: process.env.E2E_HELM_IMAGE ?? "alpine/helm:3.19.0",
  maven: process.env.E2E_MAVEN_IMAGE ?? "maven:3.9-eclipse-temurin-21",
  node: process.env.E2E_NODE_IMAGE ?? "node:22-bookworm-slim",
  oras: process.env.E2E_ORAS_IMAGE ?? "ghcr.io/oras-project/oras:v1.3.0",
  ruby: process.env.E2E_RUBY_IMAGE ?? "ruby:3.3-bookworm",
};

const PYTHON_CLIENT_IMAGE = process.env.E2E_PYTHON_IMAGE ?? "hootifactory/e2e-python-client:local";
const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const PYTHON_DOCKERFILE = join(E2E_DIR, "fixtures", "python-client.Dockerfile");
let pythonClientReady = Boolean(process.env.E2E_PYTHON_IMAGE);

export interface DockerRunOptions {
  cwd?: string;
  dockerSocket?: boolean;
  entrypoint?: string;
  env?: Record<string, string | undefined>;
  input?: string;
  mounts?: string[];
  user?: "host" | "root";
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
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    throw new Error(
      `docker run ${image} ${args.join(" ")} failed:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`,
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

export function pythonClientImage(): string {
  if (pythonClientReady) return PYTHON_CLIENT_IMAGE;
  ensureDockerAvailable();
  try {
    execFileSync("docker", ["image", "inspect", PYTHON_CLIENT_IMAGE], { stdio: "ignore" });
  } catch {
    try {
      execFileSync(
        "docker",
        [
          "build",
          "--pull",
          "-f",
          PYTHON_DOCKERFILE,
          "-t",
          PYTHON_CLIENT_IMAGE,
          dirname(PYTHON_DOCKERFILE),
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(
        `failed to build ${PYTHON_CLIENT_IMAGE}:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`,
      );
    }
  }
  pythonClientReady = true;
  return PYTHON_CLIENT_IMAGE;
}
