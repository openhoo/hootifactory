import type { PackageFormat } from "@hootifactory/types";
import { type CompiledRoute, compileRoutes } from "../routing/route-matcher";
import type { FormatAdapter } from "./adapter";

/** Holds format adapters and their pre-compiled route tables. */
export class FormatRegistry {
  private readonly adapters = new Map<PackageFormat, FormatAdapter>();
  private readonly compiled = new Map<PackageFormat, CompiledRoute[]>();

  register(adapter: FormatAdapter): void {
    this.adapters.set(adapter.format, adapter);
    this.compiled.set(adapter.format, compileRoutes(adapter.routes()));
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
