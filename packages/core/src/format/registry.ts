import type { PackageFormat } from "@hootifactory/types";
import { type CompiledRoute, compileRoutes } from "../routing/route-matcher";
import type { FormatAdapter } from "./adapter";

/** Holds format adapters and their pre-compiled route tables. */
export class FormatRegistry {
  private readonly adapters = new Map<PackageFormat, FormatAdapter>();
  private readonly compiled = new Map<PackageFormat, CompiledRoute[]>();

  register(adapter: FormatAdapter): void {
    this.registerAs(adapter.format, adapter);
  }

  /** Register an adapter under a different format key (e.g. Helm reuses the OCI adapter). */
  registerAs(format: PackageFormat, adapter: FormatAdapter): void {
    this.adapters.set(format, adapter);
    this.compiled.set(format, compileRoutes(adapter.routes()));
  }

  lookup(format: PackageFormat): FormatAdapter | undefined {
    return this.adapters.get(format);
  }

  routesFor(format: PackageFormat): CompiledRoute[] {
    return this.compiled.get(format) ?? [];
  }

  has(format: PackageFormat): boolean {
    return this.adapters.has(format);
  }

  all(): FormatAdapter[] {
    return [...this.adapters.values()];
  }
}

/** Process-wide adapter registry. Adapters self-register at startup. */
export const formatRegistry = new FormatRegistry();
