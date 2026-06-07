<div align="center">

# 🦉 Hootifactory

**A self-hostable, multi-format artifact & package manager.**

One service that replaces JFrog Artifactory + Harbor + a standalone supply-chain scanner — speaking **37 built-in registry formats** natively, with built-in malware/vulnerability scanning, policy gates, and multi-tenant RBAC.

[![CI](https://github.com/openhoo/hootifactory/actions/workflows/ci.yml/badge.svg)](https://github.com/openhoo/hootifactory/actions/workflows/ci.yml)
![Formats](https://img.shields.io/badge/formats-37-6aa84f)
![Runtime](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-black)
![Language](https://img.shields.io/badge/TypeScript-strict-3178c6)
![Tests](https://img.shields.io/badge/tested-unit%20%C2%B7%20integration%20%C2%B7%20real--client%20e2e-blueviolet)

</div>

---

Hootifactory is a single Bun/TypeScript service that gives your team a private home for **every** kind of build artifact — npm packages, Docker/OCI images, Python wheels, Helm charts, Cargo crates, Maven/Ivy/P2 artifacts, Debian/RPM/Alpine/Arch packages, Terraform modules/providers, Nix binary-cache objects, Git LFS blobs, and many more — behind one auth model, one storage layer, and one scanning pipeline. Point your existing `npm` / `docker` / `pip` / `cargo` / `helm` / `mvn` CLIs at it; no custom client required.

```bash
# The whole stack — API, web UI, workers, Postgres, MinIO — in one command:
docker compose --profile app up --build
# → web UI + registry on http://localhost:3000
```

## Why Hootifactory?

- **One tool, every ecosystem.** Stop running a separate registry per language. 37 built-in registry formats share the same repositories, tokens, quotas, and audit log.
- **Drop-in for the tools you already use.** Adapters speak each ecosystem's native protocol. Client paths are verified end-to-end against the **real** `npm`, `docker`, `oras`, `helm`, `pip`/`twine`, `go`, `cargo`, `dotnet`, `gem`/`bundler`, `composer`, `mvn`, `sbt`, `apt`, `dnf`, `pacman`, `apk`, `R`, `conda`, `conan`, `opam`, `luarocks`, `dart pub`, `swift`, `nix`, `vagrant`, `puppet`, `knife`, `git-lfs`, `pod`, `ansible-galaxy`, `curl` and more clients, driven through pinned container images (see [`tests/e2e/README.md`](tests/e2e/README.md) for the full coverage matrix and the few Windows/HTTPS-only formats that can't be CLI-tested on Linux).
- **Secure by default.** Malware + vulnerability scanning with **audit/enforce policy gates**, SSRF-guarded proxies, content-addressable immutable storage, and a production config guard that refuses to boot with dev secrets.
- **Genuinely multi-tenant.** Organizations, role-based access control with hard org-boundary enforcement, scoped API tokens, and OIDC group→role mapping.
- **Pluggable to the core.** Every format and every scanner is an independent package behind a small SDK. Adding one is *a new package plus a one-line manifest entry* — the app core never names a concrete format or scanner.

## Table of contents

- [Supported formats](#supported-formats)
- [Quick start](#quick-start)
- [Using it: publish & install](#using-it-publish--install)
- [Architecture](#architecture)
- [Repositories: hosted, proxy, virtual](#repositories-hosted-proxy-virtual)
- [Supply-chain scanning & policy gates](#supply-chain-scanning--policy-gates)
- [Security & multi-tenancy](#security--multi-tenancy)
- [Management API](#management-api)
- [Web UI](#web-ui)
- [Observability](#observability)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Testing & CI](#testing--ci)
- [Contributing](#contributing)
- [License](#license)

## Supported formats

The source of truth is [`REGISTRY_PLUGIN_MANIFEST`](packages/registry-runtime/src/manifest.ts), which currently registers 37 concrete built-in registry plugins. All built-ins support **hosted** repositories. **Virtual** repositories are available for every built-in except Git LFS today. **Proxy** (pull-through cache) is implemented where the adapter exposes `proxyIngest`: npm, Generic/raw, Conda, Puppet Forge, and Chef Supermarket.

Docker, OCI artifacts, and Helm all share the OCI Distribution `/v2/` endpoint (the `docker` plugin, aliased as `oci`/`helm`). Other aliases are module ids too: `rpm` -> `yum`/`dnf`, `ansible` -> `galaxy`, `gitlfs` -> `lfs`, `generic` -> `raw`, `alpine` -> `apk`, `arch` -> `pacman`, `puppet` -> `forge`, and `chef` -> `supermarket`.

| Ecosystem | Format | Module id(s) | Registry path |
|---|---|---|---|
| JavaScript | **npm** | `npm` | `/npm/<org>/<repo>/` |
| Containers | **Docker / OCI artifacts / Helm OCI** | `docker`, `oci`, `helm` | `/v2/<org>/<repo>/` |
| Python | **PyPI** | `pypi` | `/pypi/<org>/<repo>/` |
| Go | **Go modules** | `go` | `/go/<org>/<repo>/` |
| Rust | **Cargo** | `cargo` | `/cargo/<org>/<repo>/` |
| .NET | **NuGet** (v3) | `nuget` | `/nuget/<org>/<repo>/v3/index.json` |
| Ruby | **RubyGems** | `rubygems` | `/rubygems/<org>/<repo>/` |
| PHP | **Composer** | `composer` | `/composer/<org>/<repo>/` |
| R | **CRAN** | `cran` | `/cran/<org>/<repo>/` |
| JVM | **Maven** | `maven` | `/maven/<org>/<repo>/` |
| JVM | **Ivy** | `ivy` | `/ivy/<org>/<repo>/` |
| Eclipse | **P2** | `p2` | `/p2/<org>/<repo>/` |
| Debian/Ubuntu | **APT** | `apt` | `/apt/<org>/<repo>/` |
| RHEL/Fedora | **RPM** (YUM/DNF) | `rpm`, `yum`, `dnf` | `/rpm/<org>/<repo>/` |
| Alpine Linux | **APK** | `alpine`, `apk` | `/alpine/<org>/<repo>/` |
| Arch Linux | **Pacman** | `arch`, `pacman` | `/arch/<org>/<repo>/` |
| Nix | **Nix binary cache** | `nix` | `/nix/<org>/<repo>/` |
| Dart/Flutter | **Pub** | `pub` | `/pub/<org>/<repo>/` |
| Swift | **Swift package registry** | `swift` | `/swift/<org>/<repo>/` |
| Windows | **Chocolatey** | `chocolatey` | `/chocolatey/<org>/<repo>/` |
| Windows | **winget** | `winget` | `/winget/<org>/<repo>/` |
| macOS/Linux | **Homebrew** | `homebrew` | `/homebrew/<org>/<repo>/` |
| Windows | **Scoop** | `scoop` | `/scoop/<org>/<repo>/` |
| Apple | **CocoaPods** | `cocoapods` | `/cocoapods/<org>/<repo>/` |
| BEAM | **Hex** | `hex` | `/hex/<org>/<repo>/` |
| Haskell | **Hackage** | `hackage` | `/hackage/<org>/<repo>/` |
| OCaml | **OPAM** | `opam` | `/opam/<org>/<repo>/` |
| Lua | **LuaRocks** | `luarocks` | `/luarocks/<org>/<repo>/` |
| C/C++ | **Conan** | `conan` | `/conan/<org>/<repo>/` |
| Data science | **Conda** | `conda` | `/conda/<org>/<repo>/` |
| Infrastructure | **Terraform modules/providers** | `terraform` | `/terraform/<org>/<repo>/` |
| Infrastructure | **Vagrant boxes** | `vagrant` | `/vagrant/<org>/<repo>/` |
| Automation | **Ansible Galaxy** | `ansible`, `galaxy` | `/ansible/<org>/<repo>/` |
| Git | **Git LFS** | `gitlfs`, `lfs` | `/lfs/<org>/<repo>/` |
| Generic | **Generic/raw blobs** | `generic`, `raw` | `/generic/<org>/<repo>/` |
| Configuration | **Puppet Forge** | `puppet`, `forge` | `/puppet/<org>/<repo>/` |
| Configuration | **Chef Supermarket** | `chef`, `supermarket` | `/chef/<org>/<repo>/` |

> Registries are **immutable**: re-publishing an existing `name@version` returns `409 Conflict`.

## Quick start

### Option A — full stack in one command (demo)

```bash
cp .env.example .env
docker compose --profile app up --build
```

This builds the single Hootifactory image and starts the **API + web UI** (`:3000`), the **scan** and **mail** workers, **Postgres**, **MinIO**, and **Mailpit** (mail catcher, UI on `:8025`). The `app` profile runs `NODE_ENV=development` with demo credentials on purpose.

> ⚠️ **The compose stack is a localhost demo, not a deployment.** Ports bind to `127.0.0.1`, credentials are well-known dev defaults, and scanning runs heuristic-only. For production, run the image with `NODE_ENV=production` and real secrets — see [Deployment](#deployment).

### Option B — local dev (hot reload)

```bash
bun install
cp .env.example .env

bun run compose:up        # Postgres + MinIO + Mailpit (infra only)
bun run db:migrate
bun run db:seed           # creates a demo org + owner; prints dev credentials + an owner token

bun run dev               # API on :3000
bun run dev:web           # web UI on :5173 (proxies /v2, /api, /token → :3000)
bun run dev:worker        # scan worker (optional; needs SCANNER_ENABLED=true)
bun run dev:mail          # mail worker (Mailpit UI on :8025)
```

### First steps in the UI

1. Open the web UI and sign in with the seeded owner (dev: printed by `db:seed`).
2. **Create a repository** — pick a format module (e.g. `npm`) and a name (e.g. `libs`).
3. **Tokens → New token** — mint a scoped `hoot_…` API token. **Copy the secret once** (it's shown a single time).
4. Use that token as `$TOKEN` in the snippets below.

## Using it: publish & install

The examples below assume a hosted repo `libs` in org `acme`, a base URL of `http://localhost:3000`, and a scoped API token in `$TOKEN`. Drop `--plain-http` / `--trusted-host` / `allowInsecureConnections` once your instance is served over HTTPS.

This section documents the most common client workflows. The full built-in format set is listed above; newer adapters follow the same `/<mount>/<org>/<repo>/` repository shape, with protocol-specific routes owned by their `packages/registry-<format>` package.

<details>
<summary><b>npm</b> — <code>npm</code> / <code>yarn</code> / <code>pnpm</code></summary>

```bash
# .npmrc (project-local or ~/.npmrc)
cat > .npmrc <<EOF
registry=http://localhost:3000/npm/acme/libs/
//localhost:3000/npm/acme/libs/:_authToken=$TOKEN
EOF

npm publish                       # publish the current package
npm install my-pkg@1.0.0          # install from the repo
npm dist-tag add my-pkg@1.0.0 beta
```

Auth is the literal `_authToken` keyed on the registry `host:path`; the **trailing slash** on the registry URL matters. Scoped packages (`@acme/...`) and `npm whoami` / `search` / `pack` work too.
</details>

<details>
<summary><b>Docker</b> — <code>docker</code></summary>

```bash
# Log in with your account (or use __token__ as the username and $TOKEN as the password)
echo "$PASSWORD" | docker login localhost:3000 -u <username> --password-stdin

docker tag myapp:1.0 localhost:3000/acme/libs/app:1.0
docker push localhost:3000/acme/libs/app:1.0

docker pull localhost:3000/acme/libs/app:1.0
# or pin to an immutable digest:
docker pull localhost:3000/acme/libs/app@sha256:<digest>
```

Image refs nest the image name under the repo: `<host>/<org>/<repo>/<image>:<tag>`. Public repos allow anonymous pull; private repos require auth.
</details>

<details>
<summary><b>OCI artifacts</b> — <code>oras</code></summary>

```bash
oras login --plain-http localhost:3000 -u __token__ -p $TOKEN

# Push an arbitrary file as an OCI artifact
oras push --plain-http localhost:3000/acme/libs/demo:v1 \
  --artifact-type application/vnd.acme.artifact \
  payload.txt:application/vnd.acme.payload

# Attach an SBOM as a referrer to an existing subject
oras attach --plain-http --distribution-spec v1.1-referrers-api \
  --artifact-type application/vnd.acme.sbom \
  localhost:3000/acme/libs/demo:v1 sbom.json:application/vnd.acme.sbom+json

oras pull --plain-http localhost:3000/acme/libs/demo:v1 -o ./out
oras discover --plain-http --distribution-spec v1.1-referrers-api localhost:3000/acme/libs/demo:v1
```

Referrers require `--distribution-spec v1.1-referrers-api`.
</details>

<details>
<summary><b>Helm</b> — <code>helm</code> (OCI)</summary>

```bash
helm registry login localhost:3000 -u token -p "$TOKEN" --plain-http

helm package mychart                         # → mychart-0.1.0.tgz
helm push mychart-0.1.0.tgz oci://localhost:3000/acme/libs --plain-http   # NOTE: no chart name on push

helm pull oci://localhost:3000/acme/libs/mychart --version 0.1.0 --plain-http   # chart name IS required on pull
helm show chart oci://localhost:3000/acme/libs/mychart --version 0.1.0 --plain-http
```

The push target **omits** the chart name; pull/show/template require it.
</details>

<details>
<summary><b>PyPI</b> — <code>twine</code> / <code>pip</code></summary>

```ini
# ~/.pypirc — uploads go to /legacy/, installs read /simple/
[distutils]
index-servers = hootifactory

[hootifactory]
repository = http://localhost:3000/pypi/acme/libs/legacy/
username = __token__
password = $TOKEN
```

```bash
twine upload -r hootifactory dist/*

pip install \
  --index-url http://__token__:$TOKEN@localhost:3000/pypi/acme/libs/simple/ \
  --trusted-host localhost \
  my-pkg==1.0.0
```
</details>

<details>
<summary><b>Go modules</b> — <code>go</code> (GOPROXY)</summary>

```bash
export GOPROXY=http://localhost:3000/go/acme/libs
export GOSUMDB=off                      # modules are private to this instance
# private repo? add credentials to ~/.netrc:
#   machine localhost login __token__ password <token>

go mod download example.com/mod@v1.0.0
go list -m -versions example.com/mod
```

Go has no native publish command — upload a module with a multipart `PUT`; the `mod` field and the zip's `go.mod` must both declare the same `module` path as the upload URL:

```bash
curl -fSs -X PUT -H "Authorization: Bearer $TOKEN" \
  -F $'mod=module example.com/mod\n\ngo 1.20\n' \
  -F 'zip=@m.zip;type=application/zip' \
  http://localhost:3000/go/acme/libs/example.com/mod/@v/v1.0.0
```
</details>

<details>
<summary><b>Cargo</b> — <code>cargo</code> (sparse registry)</summary>

```toml
# .cargo/config.toml — note the trailing slash
[registries.hooti]
index = "sparse+http://localhost:3000/cargo/acme/libs/"
```

```bash
export CARGO_REGISTRIES_HOOTI_TOKEN=$TOKEN   # env var = CARGO_REGISTRIES_<NAME>_TOKEN
cargo publish --registry hooti

# consume in Cargo.toml:
#   mycrate = { version = "1.0.0", registry = "hooti" }
cargo fetch
```
</details>

<details>
<summary><b>NuGet</b> — <code>dotnet</code> / <code>nuget</code> (v3)</summary>

```xml
<!-- NuGet.Config — <clear/> drops the implicit nuget.org default -->
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="hootifactory"
         value="http://localhost:3000/nuget/acme/libs/v3/index.json"
         allowInsecureConnections="true" />
  </packageSources>
</configuration>
```

```bash
dotnet nuget push MyPkg.1.0.0.nupkg --api-key $TOKEN \
  --source http://localhost:3000/nuget/acme/libs/v3/index.json

dotnet add package MyPkg --version 1.0.0
```

Note: a NuGet version *range* resolves to the **lowest** in-range version.
</details>

<details>
<summary><b>Maven</b> — <code>mvn</code> / Gradle</summary>

```xml
<!-- settings.xml — pass as BOTH -s and -gs (Maven 3.8.1+ blocks plain-http via a bundled mirror) -->
<settings>
  <servers>
    <server>
      <id>hooti</id>
      <username>__token__</username>
      <password>$TOKEN</password>
    </server>
  </servers>
</settings>
```

```bash
mvn -B deploy:deploy-file -Dfile=app.jar \
  -DgroupId=com.hooti -DartifactId=app -Dversion=1.0.0 -Dpackaging=jar \
  -DrepositoryId=hooti -Durl=http://localhost:3000/maven/acme/libs \
  -s settings.xml -gs settings.xml

mvn -B dependency:get -Dartifact=com.hooti:app:1.0.0 \
  -DremoteRepositories=hooti::default::http://localhost:3000/maven/acme/libs \
  -s settings.xml -gs settings.xml
```
</details>

<details>
<summary><b>RubyGems</b> — <code>gem</code> / <code>bundler</code></summary>

```bash
# ~/.gem/credentials
mkdir -p ~/.gem && printf -- "---\n:hootifactory: %s\n" "$TOKEN" > ~/.gem/credentials
chmod 600 ~/.gem/credentials

gem build mygem.gemspec
gem push mygem-1.0.0.gem --key hootifactory --host http://localhost:3000/rubygems/acme/libs
```

```ruby
# Gemfile — Bundler resolves from the compact index and verifies checksums
source "http://localhost:3000/rubygems/acme/libs/"
gem "mygem", "1.0.0"
```
</details>

<details>
<summary><b>Composer</b> — <code>composer</code></summary>

```bash
composer config repositories.hootifactory composer http://localhost:3000/composer/acme/libs
composer config repositories.packagist.org false
composer config --global --auth http-basic.localhost:3000 token $TOKEN   # token = password

composer require hoot/widget:1.0.0
```

Composer has no native publish — `PUT` the dist zip with a `?version=` query param:

```bash
curl -sf -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/zip" \
  --data-binary @widget.zip \
  "http://localhost:3000/composer/acme/libs/packages/hoot/widget?version=1.0.0"
```
</details>

<details>
<summary><b>APT</b> (Debian/Ubuntu) — <code>apt</code> / <code>dpkg</code></summary>

```bash
# Add the source (unsigned repo → [trusted=yes]); a private repo embeds the token as basic auth
echo "deb [trusted=yes] http://token:$TOKEN@localhost:3000/apt/acme/libs stable main" \
  | sudo tee /etc/apt/sources.list.d/hootifactory.list

sudo apt-get update && sudo apt-get install -y hootpkg
```

Publish by `PUT`ting a `.deb` into the pool with the target suite/component; the server generates `Release`/`Packages` on the fly:

```bash
dpkg-deb --root-owner-group -Zgzip --build ./pkg out.deb
curl -sf -X PUT -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/vnd.debian.binary-package" --data-binary @out.deb \
  "http://localhost:3000/apt/acme/libs/pool/main/h/hootpkg/hootpkg_1.0.0_amd64.deb?suite=stable&component=main"
```
</details>

<details>
<summary><b>RPM</b> (RHEL/Fedora) — <code>dnf</code> / <code>yum</code></summary>

```bash
sudo tee /etc/yum.repos.d/hootifactory.repo <<EOF
[hootifactory]
name=Hootifactory
baseurl=http://localhost:3000/rpm/acme/libs
enabled=1
gpgcheck=0
EOF

sudo dnf makecache && sudo dnf install -y hello
```

Publish by `PUT`ting the `.rpm` (identity is read from the RPM header); the server builds `repodata/` deterministically:

```bash
curl -sf -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/x-rpm" \
  --data-binary @hello-1.2.3-4.el9.x86_64.rpm \
  http://localhost:3000/rpm/acme/libs/packages/hello-1.2.3-4.el9.x86_64.rpm
```
</details>

<details>
<summary><b>Pub</b> (Dart/Flutter) — <code>dart pub</code></summary>

```yaml
# pubspec.yaml of the package you publish
publish_to: http://localhost:3000/pub/acme/libs
```

```bash
dart pub token add http://localhost:3000/pub/acme/libs   # paste $TOKEN when prompted
dart pub publish
```

```yaml
# consume as a hosted dependency
dependencies:
  mypkg:
    hosted:
      name: mypkg
      url: http://localhost:3000/pub/acme/libs
    version: ^1.0.0
```
</details>

<details>
<summary><b>Swift</b> — <code>swift package-registry</code></summary>

```bash
swift package-registry set http://localhost:3000/swift/acme/libs
swift package-registry login http://localhost:3000/swift/acme/libs --token "$TOKEN"

swift package-registry publish acme.libs 1.0.0 --url http://localhost:3000/swift/acme/libs

# consume by package identifier in Package.swift:
#   .package(id: "acme.libs", from: "1.0.0")
swift package resolve
```
</details>

<details>
<summary><b>Chocolatey</b> — <code>choco</code></summary>

```powershell
choco source add -n hootifactory -s "http://localhost:3000/chocolatey/acme/libs/" -u token -p "$TOKEN"
choco apikey add -s "http://localhost:3000/chocolatey/acme/libs/" -k "$TOKEN"

choco push mypkg.1.0.0.nupkg -s "http://localhost:3000/chocolatey/acme/libs/" --api-key "$TOKEN"
choco install mypkg --version 1.0.0 -s "http://localhost:3000/chocolatey/acme/libs/" -u token -p "$TOKEN"
```

Serves a NuGet v2 (OData) feed; push auth uses the `x-nuget-apikey` header, reads use HTTP Basic.
</details>

<details>
<summary><b>winget</b> — <code>winget</code></summary>

```powershell
winget source add --name hootifactory --type "Microsoft.Rest" `
  --arg "http://localhost:3000/winget/acme/libs/"

winget install Acme.Tool --version 1.0.0 --source hootifactory
```

Publishing is a Hootifactory extension (public winget REST is read-only) — `PUT` a multipart manifest + installer; the URL's `PackageIdentifier` must equal `Publisher.PackageName`.
</details>

<details>
<summary><b>Homebrew</b> — <code>brew</code></summary>

```bash
export HOMEBREW_API_DOMAIN="http://localhost:3000/homebrew/acme/libs/api"
export HOMEBREW_BOTTLE_DOMAIN="http://localhost:3000/homebrew/acme/libs/bottles"

brew install mytool
```

Publish bottles via a multipart `PUT` to `/api/formula/<name>/<version>/<tag>` (a `bottle` file part + optional `formula` JSON).
</details>

<details>
<summary><b>Scoop</b> — <code>scoop</code></summary>

```powershell
scoop bucket add hootifactory "http://localhost:3000/scoop/acme/libs"
scoop install mytool
```

Publish via a multipart `PUT` to `/<app>` with a `manifest` JSON part (omitting `url`/`hash` — the server derives them from the stored, scanned blob) and an `artifact` file part.
</details>

## Architecture

Hootifactory is a Bun/TypeScript monorepo where **every artifact format and every scanner is an independent workspace package** implementing a small SDK contract. The application core never names a concrete format or scanner — each is named in exactly one place: its runtime loader's static manifest.

```
apps/
  api/          registry HTTP server + management API + web host (Bun + Hono)
  scan-worker/  async scanning pipeline (durable Postgres outbox)
  mail-worker/  transactional email (pg-boss queue)
  web/          management UI (React 19 + Vite + Tailwind v4 + shadcn/ui)
packages/
  config/  types/  core/  db/  storage/  auth/  contracts/  queue/  observability/  scan-core/  email/
  registry/              protocol-neutral registry plugin SDK (contract + helpers)
  registry-application/  agnostic platform use-cases, sliced: routing · runtime · repositories ·
                         content · inventory · packages · governance · assets
  registry-runtime/      static plugin manifest + config-driven loader
  registry-{npm,oci,pypi,go,cargo,nuget,rubygems,composer,cran,maven,ivy,apt,p2,pub,swift,
            chocolatey,cocoapods,winget,homebrew,hex,scoop,vagrant,rpm,ansible,gitlfs,
            terraform,conan,conda,generic,alpine,nix,arch,hackage,puppet,chef,opam,
            luarocks}          ← one package per built-in registry format
  scanner/               scanner plugin SDK (ScannerPlugin contract + registry + runners)
  scanner-runtime/       static scanner manifest + config-driven loader
  scanner-{heuristic,grype,trivy,clamav,osv}    ← one package per scanner
```

**The plugin model**

- Two SDK packages define the contracts: `@hootifactory/registry` (the `RegistryPlugin` descriptor — `routes()`, `requiredPermission()`, `handle()`, plus optional virtual/proxy hooks) and `@hootifactory/scanner` (the `ScannerPlugin` interface). A concrete plugin's *only* `@hootifactory` dependency is its SDK.
- Registry plugins are **declarative**: a plugin supplies a mount segment, capability flags (`contentAddressable`, `resumableUploads`, `proxyable`, `virtualizable`), route entries with agnostic flags (`searchable`, `metadataMergeable`, `serviceIndex`, …), a `(method, route) → permission` mapping, and optional `generateMetadata` / `mergeMetadata` / `search` / `proxyIngest`. The platform owns HTTP, routing, auth/RBAC, content-addressable storage, and scan execution.
- Registration is a **static manifest** (`registry-runtime` / `scanner-runtime`) — the single place that imports concrete plugins — optionally narrowed at runtime by the `REGISTRY_PLUGINS` / `SCANNERS` operator allowlists. Aliases are module ids, not packages (`docker` -> `oci`/`helm`, `rpm` -> `yum`/`dnf`, `generic` -> `raw`, and so on).
- **Adding a format = a new `registry-<fmt>` package + one manifest line.** No edit to the app core, the boundary checker, or any sibling plugin.

**Enforced boundaries.** `bun run check:boundaries` discovers plugin packages from the workspace and fails the build if any app or agnostic package imports a concrete format/scanner, re-acquires format-specific identity (e.g. hardcoded `/v2/` grammar or OCI-ish identifiers), or declares workspace dependencies that drift from what it imports. It also validates the `registry-application` slice exports and API v1 contract usage. The boundary check is the source of truth for enforced module rules.

## Repositories: hosted, proxy, virtual

Every repository has a `kind`, dispatched by a single exhaustive switch:

- **Hosted** — read/write locally; the only kind that accepts publishes.
- **Proxy** (pull-through cache) — read-only; on a local miss it mirrors from a configured upstream **through the format plugin's `proxyIngest`** (never transparent passthrough), so upstream bytes still pass scan policy, quotas, and retention. Implemented today for npm, Generic/raw, Conda, Puppet Forge, and Chef Supermarket.
- **Virtual** (group/aggregate) — read-only; available for plugins that advertise `virtualizable` (currently every built-in except Git LFS). It fans out over ordered member repos (bounded-concurrent, default 8; member cap 32), returns the first non-error response or merges metadata/search, and **rewrites member mount paths back to the virtual mount** so clients keep routing through it. Each member is authorized independently.

**Content-addressable storage.** Artifact bytes live in an S3-compatible store (S3 / MinIO / R2) keyed by `sha256` with two-level prefix fan-out. Dedup is two-tiered: storage-level (skip the write if the digest exists) and DB-level (a shared `blobs` row with per-repo `blob_refs` and reference counting). Org storage quota is charged **once** per digest per org. A grace-period sweeper reclaims unreferenced blobs from both the DB and S3.

**SSRF protection.** All upstream fetches go through `safeFetch`, which pins connections to a resolved **public** IP and re-validates every redirect hop. Loopback, RFC1918, link-local/metadata (`169.254.169.254`), CGNAT, and IPv4-in-IPv6 forms are blocked — and a public hostname that resolves to a private address is rejected. `REGISTRY_ALLOW_PRIVATE_UPSTREAMS=true` (dev/test only) is **refused outright in production**.

## Supply-chain scanning & policy gates

Scanning is **off by default** (`SCANNER_ENABLED=false`). When enabled, every published artifact is scanned asynchronously through a durable Postgres **scan outbox**: the registry upsert records an outbox row, and the `scan-worker` runs its own claim/process loop (`FOR UPDATE SKIP LOCKED` — *not* pg-boss) with retry/backoff, a stuck-scan reclaimer, and idempotent rescans.

**Scanners** are plugins dispatched purely by `inputKind` (`stream` / `content` / `dependencies`):

| Scanner | Detects | Notes |
|---|---|---|
| `heuristic-malware` | malware | **always-on baseline**, offline (EICAR signature, streaming) |
| `heuristic-deps` | vulnerabilities | **always-on baseline**, offline (built-in advisory DB) |
| `grype` | vulnerabilities | Anchore Grype, sandboxed Docker CLI |
| `trivy` | vulnerabilities | Aqua Trivy, CLI or client/server (`TRIVY_SERVER_URL`) |
| `clamav` | malware | `clamscan` or ClamAV REST (`CLAMAV_REST_URL`) |
| `osv` | vulnerabilities | OSV.dev — **network, opt-in** (`SCANNER_OSV`) |

The two heuristic baselines are **irreducible**: the `SCANNERS` allowlist can narrow the external set but can never disable the offline malware/advisory gate. External CLI scanners run in **hardened Docker sandboxes** (`--network none --read-only --cap-drop ALL --security-opt no-new-privileges`, non-root, tmpfs, memory/cpu/pids caps) pinned to `@sha256:` digests — enforced at startup in production.

**Policy gates.** Findings are evaluated against the repo's most-specific scan policy:

- **`audit`** (default) — a violating artifact is **quarantined**; only `blocked` artifacts are withheld.
- **`enforce`** — a violating artifact is **blocked**, and serving is **fail-closed**: bytes stay unavailable until a scanner *positively* marks the artifact clean (the stuck-scan reclaimer prevents a dead worker from permanently wedging downloads).

## Security & multi-tenancy

- **Organizations + RBAC.** A single authoritative `can()` decision function backs every access check. Four roles (`viewer` → `developer` → `admin` → `owner`); `admin` and `owner` share the same action set (owner outranks only for grant ceilings / management). Anonymous access is allowed *only* for `read` on `public` repositories/packages/artifacts.
- **Hard org boundary.** A token is bound to its issuing org on **every** call — `resource.orgId` is resolved from the DB, never trusted from the request path. A cross-org token request is denied outright.
- **Scoped API tokens.** Opaque `hoot_`-prefixed secrets (256-bit), stored only as a SHA-256 hash. Tokens carry structured **grants** (a hard ceiling — the grant *and* the resolved role must both allow an action), support repository glob patterns, expiry, rotation, and revocation, and can never exceed their owner's current role.
- **OIDC SSO.** PKCE + signed/expiring state; IdP groups map to per-org roles, re-synced transactionally on every login (removing a group revokes access). Auto-provisioning requires a verified email claim.
- **OCI bearer tokens.** Short-lived RS256 JWTs (`REGISTRY_JWT_*`), algorithm-pinned against alg-confusion, with the access claim shape validated so a malformed claim degrades to deny-all.
- **Hardening.** Argon2id passwords with constant-time login, DB-backed atomic login/registration/reset throttling (hashed bucket keys, multi-replica safe), session-cookie CSRF rejection on cross-origin writes, strict security headers (CSP, HSTS in prod, `no-store` on credentialed/registry paths), in-flight upload-byte admission control, and a fire-and-forget **audit log** on every mutation.
- **Production secret guard.** With `NODE_ENV=production` the process **refuses to boot** if any dev-default secret remains (session secret, S3 creds, DB creds), if the registry JWT keypair is missing, or if private upstreams are enabled.

## Management API

A versioned REST API under **`/api/v1`** (Bearer-token auth), self-described at `GET /api/v1/docs` with an OpenAPI document at `GET /api/v1/openapi.json`. Endpoints cover:

- **Identity & orgs** — `GET /me`, `GET /orgs`, `GET /orgs/:orgId`
- **Repositories** — list / create / detail; add proxy **upstreams** and virtual-repo **members** (admin)
- **Content** — packages, versions (+ assets), artifacts, assets
- **Findings** — `GET /artifacts/:artifactId/findings` (vuln / license / secret / malware, filter by severity)
- **Tokens** — list / create / rotate / revoke (secret returned once)
- **Governance** — upsert scan policies, get/set storage & artifact quotas, apply retention

**Governance enforcement.** Per-org **quotas** (storage bytes + artifact counts; null = unlimited) are checked under a `FOR UPDATE` row lock on the publish path. **Retention** soft-deletes versions beyond `keepLastN` per package, reclaims blob refs and CAS bytes, and decrements quota usage — all transactionally.

Liveness/readiness live outside the versioned namespace: `GET /healthz` (liveness) and `GET /readyz` (verifies DB connectivity; `503` when not ready).

## Web UI

A React 19 SPA (TanStack Router + Query, Tailwind v4, shadcn/ui) for self-service management: sign-in / registration / password reset / OIDC, an org switcher, a dashboard overview, repository list + detail (with the repo's base URL), and org-scoped API-token minting. In production the API serves the prebuilt SPA from `WEB_DIST` (single container); in dev it runs under Vite (`:5173`) proxying registry + API paths.

> Scan findings and the audit log are exposed via the **API**, not the web UI today.

## Observability

The API and both workers emit correlated JSON logs by default. Each HTTP request gets `x-request-id` / `x-correlation-id` headers, and log lines within a request or its derived queue jobs carry `request_id`, `correlation_id`, `trace_id`, and `span_id`.

Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318` to export logs, traces, and metrics over OTLP/HTTP (per-signal endpoint overrides exist). Traces span HTTP ingress, auth resolution, repository resolution, RBAC decisions, adapter dispatch, proxy refreshes, virtual fan-out, queue/worker lifecycle, email delivery, and every scan phase from artifact load to policy decision. Metrics cover HTTP, registry dispatch, and worker queue counts/durations/active-job gauges. Default service names (`hootifactory-api` / `-scan-worker` / `-mail-worker`) are overridable via `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES`.

## Configuration

All configuration is environment-driven and validated at startup — see [`.env.example`](.env.example) for the full annotated reference. Highlights:

| Area | Key variables |
|---|---|
| API | `API_PORT`, `API_HOST`, `REGISTRY_PUBLIC_URL`, `APP_PUBLIC_URL` |
| Database | `DATABASE_URL`, `DATABASE_POOL_*` |
| Storage | `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` |
| Auth | `SESSION_SECRET`, `REGISTRY_JWT_PRIVATE_KEY`/`_PUBLIC_KEY`, `AUTH_ALLOW_REGISTRATION`, `AUTH_OIDC_*` |
| Plugins | `REGISTRY_PLUGINS`, `SCANNERS` (allowlists; unset = all built-ins) |
| Scanning | `SCANNER_ENABLED`, `SCANNER_CLI_RUNTIME`, `SCANNER_OSV`, `SCAN_MAX_BYTES`, `*_IMAGE` |
| Email | `EMAIL_ENABLED`, `EMAIL_SMTP_*`, `EMAIL_FROM` |

`AUTH_ALLOW_REGISTRATION` / `AUTH_ALLOW_ORG_CREATION` default **on** in dev/test and **off** in production unless set explicitly.

## Deployment

Hootifactory ships as a **single multi-stage Docker image**. The same image runs the API (default), the scan worker, or the mail worker — selected by overriding the container command. The API serves the prebuilt web UI from `WEB_DIST`, runs as a non-root user, and exposes a `/readyz` healthcheck.

For production, run the image with `NODE_ENV=production` (the image default) and provide real secrets — `SESSION_SECRET`, the `REGISTRY_JWT_*` keypair, S3 credentials, and a non-default `DATABASE_URL`. The config guard fails fast on dev defaults, so **do not** deploy the compose demo. Bootstrap the first org with `SEED_USER` / `SEED_PASS` set explicitly; production seed runs never print passwords or token secrets.

> Keep database dumps outside the repo tree (or encrypt them) — they can contain token, session, and password hashes even when no raw secrets are present.

## Testing & CI

A three-tier pyramid:

```bash
bun run test             # unit — hermetic *.test.ts across every package (no DB/S3)
bun run test:integration # service-backed *.integration.test.ts (real Postgres + MinIO)
bun run test:all         # unit + integration

bun run e2e:install      # one-time: Playwright chromium
bun run test:e2e         # Playwright e2e — browser UI, proxy/virtual, scanning, governance
bun run test:e2e:clients # real-client specs only — drives npm/docker/oras/pip/helm/go/cargo/
                         # dotnet/gem/composer/mvn/apt/… through pinned Docker images
```

**Docker is the integration boundary for external CLIs** — the real-client specs run actual package managers, and the optional scanner CLIs (Grype/Trivy/ClamAV) default to Docker images. Name service-backed tests `*.integration.test.ts` so the default unit pass stays fast and hermetic.

**CI gate** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) — a single aggregating `PR gate` status check fans out to five jobs: **commit-lint** (Conventional Commits on every commit + the PR title), **lint** (`biome check`), **typecheck** (`tsc --noEmit`), **architecture** (`check:boundaries`), and **coverage** (a per-package line-coverage floor — every package must hit 80% on its own `src/`, never lowered).

## Contributing

- **Runtime:** Bun `≥ 1.3` (CI pins `1.3.14`). No npm/yarn — the workspace is Bun-native.
- **Commits:** Conventional Commits (the squash subject = the PR title; both are linted).
- **Before pushing:** `bun run lint`, `bun run typecheck`, `bun run check:boundaries`, `bun run test`.
- **Adding a format or scanner:** create a `registry-<fmt>` / `scanner-<name>` package depending only on its SDK, implement the plugin contract, and add one entry to the runtime manifest — the boundary check enforces the rest.

## License

This repository does not currently ship a `LICENSE` file (the package is marked `private`). Until one is added, no license is granted for reuse or distribution — add a `LICENSE` before publishing or open-sourcing.
