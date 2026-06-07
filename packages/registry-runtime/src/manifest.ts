import type { RegistryPlugin } from "@hootifactory/registry";
import { aptRegistryPlugin } from "@hootifactory/registry-apt";
import { cargoRegistryPlugin } from "@hootifactory/registry-cargo";
import { chocolateyRegistryPlugin } from "@hootifactory/registry-chocolatey";
import { composerRegistryPlugin } from "@hootifactory/registry-composer";
import { genericRegistryPlugin } from "@hootifactory/registry-generic";
import { goRegistryPlugin } from "@hootifactory/registry-go";
import { homebrewRegistryPlugin } from "@hootifactory/registry-homebrew";
import { mavenRegistryPlugin } from "@hootifactory/registry-maven";
import { npmRegistryPlugin } from "@hootifactory/registry-npm";
import { nugetRegistryPlugin } from "@hootifactory/registry-nuget";
import { dockerRegistryPlugin } from "@hootifactory/registry-oci";
import { pubRegistryPlugin } from "@hootifactory/registry-pub";
import { pypiRegistryPlugin } from "@hootifactory/registry-pypi";
import { rpmRegistryPlugin } from "@hootifactory/registry-rpm";
import { rubygemsRegistryPlugin } from "@hootifactory/registry-rubygems";
import { scoopRegistryPlugin } from "@hootifactory/registry-scoop";
import { swiftRegistryPlugin } from "@hootifactory/registry-swift";
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
  { plugin: mavenRegistryPlugin },
  { plugin: aptRegistryPlugin },
  { plugin: pubRegistryPlugin },
  { plugin: swiftRegistryPlugin },
  { plugin: chocolateyRegistryPlugin },
  { plugin: wingetRegistryPlugin },
  { plugin: homebrewRegistryPlugin },
  { plugin: genericRegistryPlugin, aliases: ["raw"] },
  { plugin: scoopRegistryPlugin },
  { plugin: rpmRegistryPlugin, aliases: ["yum", "dnf"] },
];
