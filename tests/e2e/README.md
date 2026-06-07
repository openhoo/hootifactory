# End-to-end tests

Playwright specs that exercise the running stack (API `:3399`, scan-worker `:3398`,
Vite `:5174`) against an isolated `hootifactory_test` database. `tests/global-setup.ts`
creates + migrates the DB; `playwright.config.ts` boots the `webServer`s.

```bash
bun run test:e2e            # everything
bun run test:e2e:clients    # only the Dockerized real-client specs (tests/e2e/*-cli.spec.ts)
```

## Dockerized real-client CLI specs (`*-cli.spec.ts`)

These drive the **real** ecosystem CLI inside a pinned Docker image against the live
server, via the `dockerRun` harness in [`docker-clients.ts`](./docker-clients.ts) (on
Linux it uses `--network host`, so the container reaches the host API directly). Images
are pinned in `CLI_IMAGES` (override per-format with `E2E_<FORMAT>_IMAGE`); a few clients
that ship in no stock image are built on first use from `fixtures/<key>-client.Dockerfile`
(`curl`, `cocoapods`, `gitlfs`, `chef`, `vagrant`, plus the existing `python`).

Every registry format with a Linux-runnable client is covered. "Publish" is either the
real CLI or — where the ecosystem has no Linux publish client (the upload is a
hootifactory extension, or the real publish tool needs a hosted account / signed
requests) — a raw HTTP request; "consume" is always the real CLI.

| Format | Spec | Client (image) | Publish | Consume |
| --- | --- | --- | --- | --- |
| npm | `npm-cli` | npm (`node`) | CLI | CLI |
| Docker/OCI/Helm | `docker-cli`, `oci-cli`, `helm-cli` | docker / oras / helm | CLI | CLI |
| PyPI | `pypi-cli` | pip/twine (built) | CLI | CLI |
| Go | `go-cli` | go | CLI | CLI |
| Cargo | `cargo-cli` | cargo | CLI | CLI |
| NuGet | `nuget-cli` | dotnet | CLI | CLI |
| RubyGems | `rubygems-cli` | gem/bundler | CLI | CLI |
| Composer | `composer-cli` | composer | HTTP | CLI |
| Maven | `maven-cli` | mvn | CLI | CLI |
| APT | `apt-cli` | apt-get | HTTP | CLI |
| Generic/raw | `generic-cli` | curl (built) | CLI | CLI |
| Alpine | `alpine-cli` | apk | HTTP | CLI |
| Ansible | `ansible-cli` | ansible-galaxy | HTTP¹ | CLI |
| CRAN | `cran-cli` | R | HTTP | CLI |
| RPM | `rpm-cli` | dnf | HTTP | CLI |
| Arch | `arch-cli` | pacman | HTTP | CLI |
| Conda | `conda-cli` | micromamba | HTTP | CLI |
| Conan | `conan-cli` | conan | CLI | CLI |
| opam | `opam-cli` | opam | HTTP | CLI |
| LuaRocks | `luarocks-cli` | luarocks | HTTP² | CLI |
| Dart/pub | `pub-cli` | dart pub | CLI | CLI |
| Swift | `swift-cli` | swift (SwiftPM) | HTTP³ | CLI |
| Nix | `nix-cli` | nix | CLI | CLI |
| Vagrant | `vagrant-cli` | vagrant (built) | HTTP⁴ | CLI |
| Puppet | `puppet-cli` | puppet (puppet-agent) | HTTP⁵ | CLI |
| Chef | `chef-cli` | knife (built) | HTTP⁶ | CLI |
| Git LFS | `gitlfs-cli` | git-lfs (built) | HTTP⁷ | CLI |
| Homebrew | `homebrew-cli` | n/a (see below) | HTTP | — |
| Ivy | `ivy-cli` | sbt | HTTP⁸ | CLI |
| CocoaPods | `cocoapods-cli` | pod (built) | HTTP⁹ | CLI |

¹ `ansible-galaxy publish` base64-encodes the multipart file part, which Bun's `formData()`
does not decode. ² `luarocks upload` carries the api-key only in the URL path (no auth
header). ³ `swift package-registry login` force-rewrites the URL to https, so publish
can't authenticate over plain HTTP. ⁴ `vagrant cloud publish` targets the unimplemented
Vagrant Cloud API. ⁵ `puppet`/PDK uses base64-in-JSON Forge upload. ⁶ `knife supermarket
share` signs requests with Chef's X-Ops RSA protocol. ⁷ `git lfs push` requires a
plain-HTTP credential dance that reliably hangs. ⁸ Apache Ivy has no publish CLI. ⁹ `pod`
has no CLI that publishes through this adapter. In each case the upload is a small raw
HTTP request and the **consume** still uses the real CLI.

### Formats with no Linux-runnable real-client e2e

These adapters are exercised by package-level protocol/unit tests instead, because no real
CLI can drive them against the plain-HTTP test server on Linux:

| Format | Why a real-CLI Docker e2e is not feasible |
| --- | --- |
| Terraform | The CLI's registry protocol mandates HTTPS (service discovery via `https://<host>/.well-known/terraform.json`); there is no plain-HTTP escape hatch. |
| Hackage | `cabal` downloads tarballs from `/package/<pkgid>.tar.gz` (one segment); the adapter serves `/package/:id/:file` (two segments), so `cabal build`/`get` 404. |
| Hex | The Hex repo protocol is signed gzipped protobuf (Ed25519-verified); the adapter serves a JSON simplification that `mix` cannot decode. |
| Chocolatey | `choco` runs only under Mono on Linux, ships in no stock image, and `choco install` executes Windows PowerShell. |
| Scoop | `scoop` is a Windows/PowerShell-only installer. |
| WinGet | `winget` is a Windows-only AppX/MSIX app. |
| P2 | The only consumer is the Eclipse p2 director (a heavy Equinox app shipped in no small/official image). |

> Homebrew is listed in the table above as HTTP-publish only: the JSON formula/bottle API
> is verified server-side, but stock `brew` 4.x demands the JWS-signed `formula.jws.json`
> the adapter doesn't serve and refuses plain-HTTP `HOMEBREW_API_DOMAIN`, so it has no
> real-CLI consume step.
