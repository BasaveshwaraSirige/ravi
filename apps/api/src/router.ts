export type RouteHandler = (ctx: {
  req: Request;
  url: URL;
  params: Record<string, string>;
}) => Promise<Response> | Response;

type Route = {
  method: string;
  pattern: string;
  handler: RouteHandler;
};

export class Router {
  private routes: Route[] = [];

  on(method: string, pattern: string, handler: RouteHandler) {
    this.routes.push({ method: method.toUpperCase(), pattern, handler });
    return this;
  }

  async handle(req: Request) {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const pathname = url.pathname;

    for (const r of this.routes) {
      if (r.method !== method) continue;
      const params = matchPattern(r.pattern, pathname);
      if (!params) continue;
      return await r.handler({ req, url, params });
    }
    return null;
  }
}

function matchPattern(pattern: string, pathname: string) {
  if (pattern === pathname) return {};
  const pParts = pattern.split("/").filter(Boolean);
  const uParts = pathname.split("/").filter(Boolean);
  if (pParts.length !== uParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < pParts.length; i++) {
    const pp = pParts[i];
    const up = uParts[i];
    if (pp.startsWith(":")) {
      params[pp.slice(1)] = decodeURIComponent(up);
      continue;
    }
    if (pp !== up) return null;
  }
  return params;
}

