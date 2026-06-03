import type { HttpMethod, RouteEntry, RouteMatch } from "../format/adapter";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface CompiledRoute {
  entry: RouteEntry;
  regex: RegExp;
  paramNames: string[];
}

/**
 * Compile a route pattern into a RegExp.
 *  - `:param`  -> a single path segment   ([^/]+)
 *  - `:param+` -> greedy, may span slashes (.+?)  (anchored by trailing literals)
 * A trailing slash in the pattern is treated as optional.
 */
export function compileRoute(entry: RouteEntry): CompiledRoute {
  const paramNames: string[] = [];
  const segments = entry.pattern.split("/");
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "") {
      out.push("");
      continue;
    }
    if (seg.startsWith(":")) {
      const greedy = seg.endsWith("+");
      const name = greedy ? seg.slice(1, -1) : seg.slice(1);
      paramNames.push(name);
      out.push(greedy ? "(.+?)" : "([^/]+)");
    } else {
      out.push(escapeRegex(seg));
    }
  }
  let body = out.join("/");
  body = body.replace(/\/$/, "/?"); // optional trailing slash
  return { entry, regex: new RegExp(`^${body}$`), paramNames };
}

export function compileRoutes(entries: RouteEntry[]): CompiledRoute[] {
  return entries.map(compileRoute);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** First matching route for (method, path). Routes are tried in declared order. */
export function matchRoute(
  routes: CompiledRoute[],
  method: HttpMethod,
  path: string,
): RouteMatch | null {
  for (const c of routes) {
    if (c.entry.method !== method) continue;
    const m = c.regex.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    c.paramNames.forEach((name, i) => {
      params[name] = safeDecode(m[i + 1] ?? "");
    });
    return { entry: c.entry, params, path };
  }
  return null;
}
