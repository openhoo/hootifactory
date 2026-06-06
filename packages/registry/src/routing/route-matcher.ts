import type { HttpMethod, RouteEntry, RouteMatch } from "../plugin/adapter";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface CompiledRouteParam {
  name: string;
  /** `:param+` may span slashes; a plain `:param` must be one slash-free segment. */
  greedy: boolean;
}

export interface CompiledRoute {
  entry: RouteEntry;
  regex: RegExp;
  params: CompiledRouteParam[];
}

/**
 * Compile a route pattern into a RegExp.
 *  - `:param`  -> a single path segment   ([^/]+)
 *  - `:param+` -> greedy, may span slashes (.+?)  (anchored by trailing literals)
 * A trailing slash in the pattern is treated as optional.
 */
export function compileRoute(entry: RouteEntry): CompiledRoute {
  const params: CompiledRouteParam[] = [];
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
      params.push({ name, greedy });
      out.push(greedy ? "(.+?)" : "([^/]+)");
    } else {
      out.push(escapeRegex(seg));
    }
  }
  let body = out.join("/");
  body = body.replace(/\/$/, "/?"); // optional trailing slash
  return { entry, regex: new RegExp(`^${body}$`), params };
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
    let rejected = false;
    c.params.forEach((p, i) => {
      const value = safeDecode(m[i + 1] ?? "");
      // A single-segment `:param` matched `[^/]+` against the still-encoded path,
      // so a percent-encoded separator (`%2F`) slips through as one segment and
      // decodes into an embedded slash. Such a value is not one slash-free
      // segment, so fail the match instead of silently honouring it. Greedy
      // `:param+` legitimately spans slashes and is left untouched.
      if (!p.greedy && value.includes("/")) rejected = true;
      params[p.name] = value;
    });
    if (rejected) continue;
    return { entry: c.entry, params, path };
  }
  return null;
}
