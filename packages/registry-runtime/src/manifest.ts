import type { RegistryPlugin } from "@hootifactory/registry";
import { alpineRegistryPlugin } from "@hootifactory/registry-alpine";
import { ansibleRegistryPlugin } from "@hootifactory/registry-ansible";
import { aptRegistryPlugin } from "@hootifactory/registry-apt";
import { archRegistryPlugin } from "@hootifactory/registry-arch";
import { cargoRegistryPlugin } from "@hootifactory/registry-cargo";
import { chefRegistryPlugin } from "@hootifactory/registry-chef";
import { chocolateyRegistryPlugin } from "@hootifactory/registry-chocolatey";
import { cocoapodsRegistryPlugin } from "@hootifactory/registry-cocoapods";
import { composerRegistryPlugin } from "@hootifactory/registry-composer";
import { conanRegistryPlugin } from "@hootifactory/registry-conan";
import { condaRegistryPlugin } from "@hootifactory/registry-conda";
import { cranRegistryPlugin } from "@hootifactory/registry-cran";
import { genericRegistryPlugin } from "@hootifactory/registry-generic";
import { gitlfsRegistryPlugin } from "@hootifactory/registry-gitlfs";
import { goRegistryPlugin } from "@hootifactory/registry-go";
import { hackageRegistryPlugin } from "@hootifactory/registry-hackage";
import { hexRegistryPlugin } from "@hootifactory/registry-hex";
import { homebrewRegistryPlugin } from "@hootifactory/registry-homebrew";
import { ivyRegistryPlugin } from "@hootifactory/registry-ivy";
import { mavenRegistryPlugin } from "@hootifactory/registry-maven";
import { nixRegistryPlugin } from "@hootifactory/registry-nix";
import { npmRegistryPlugin } from "@hootifactory/registry-npm";
import { nugetRegistryPlugin } from "@hootifactory/registry-nuget";
import { dockerRegistryPlugin } from "@hootifactory/registry-oci";
import { p2RegistryPlugin } from "@hootifactory/registry-p2";
import { pubRegistryPlugin } from "@hootifactory/registry-pub";
import { puppetRegistryPlugin } from "@hootifactory/registry-puppet";
import { pypiRegistryPlugin } from "@hootifactory/registry-pypi";
import { rpmRegistryPlugin } from "@hootifactory/registry-rpm";
import { rubygemsRegistryPlugin } from "@hootifactory/registry-rubygems";
import { scoopRegistryPlugin } from "@hootifactory/registry-scoop";
import { swiftRegistryPlugin } from "@hootifactory/registry-swift";
import { terraformRegistryPlugin } from "@hootifactory/registry-terraform";
import { vagrantRegistryPlugin } from "@hootifactory/registry-vagrant";
import { wingetRegistryPlugin } from "@hootifactory/registry-winget";

/** A built-in registry plugin plus any extra module ids it serves. */
export interface RegistryPluginEntry {
  plugin: RegistryPlugin;
  /** Additional module ids backed by the same plugin (e.g. OCI also serves Helm). */
  aliases?: string[];
}

/**
 * The built-in registry set — the single place that names concrete registry
 * packages and their module aliases. Discovery is static (frozen dependency
 * graph for the bundler/Docker); the operator allowlist (REGISTRY_PLUGINS)
 * selects which module ids to register. The OCI plugin's `oci`/`helm` aliases
 * are data here rather than imperative `registerAs` calls in the loader.
 */
export const REGISTRY_PLUGIN_MANIFEST: RegistryPluginEntry[] = [
  { plugin: npmRegistryPlugin },
  { plugin: dockerRegistryPlugin, aliases: ["oci", "helm"] },
  { plugin: pypiRegistryPlugin },
  { plugin: goRegistryPlugin },
  { plugin: cargoRegistryPlugin },
  { plugin: nugetRegistryPlugin },
  { plugin: rubygemsRegistryPlugin },
  { plugin: composerRegistryPlugin },
  { plugin: cranRegistryPlugin },
  { plugin: mavenRegistryPlugin },
  { plugin: ivyRegistryPlugin },
  { plugin: aptRegistryPlugin },
  { plugin: p2RegistryPlugin },
  { plugin: pubRegistryPlugin },
  { plugin: swiftRegistryPlugin },
  { plugin: chocolateyRegistryPlugin },
  { plugin: cocoapodsRegistryPlugin },
  { plugin: wingetRegistryPlugin },
  { plugin: homebrewRegistryPlugin },
  { plugin: hexRegistryPlugin },
  { plugin: scoopRegistryPlugin },
  { plugin: vagrantRegistryPlugin },
  { plugin: rpmRegistryPlugin, aliases: ["yum", "dnf"] },
  { plugin: ansibleRegistryPlugin, aliases: ["galaxy"] },
  { plugin: gitlfsRegistryPlugin, aliases: ["lfs"] },
  { plugin: terraformRegistryPlugin },
  { plugin: conanRegistryPlugin },
  { plugin: condaRegistryPlugin },
  { plugin: genericRegistryPlugin, aliases: ["raw"] },
  { plugin: alpineRegistryPlugin, aliases: ["apk"] },
  { plugin: nixRegistryPlugin },
  { plugin: archRegistryPlugin, aliases: ["pacman"] },
  { plugin: hackageRegistryPlugin },
  { plugin: puppetRegistryPlugin, aliases: ["forge"] },
  { plugin: chefRegistryPlugin, aliases: ["supermarket"] },
];
