import { envBool } from "./env";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf"
};

export async function serveStaticFile(filePath: string) {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  const ext = extname(filePath);
  const headers = new Headers();
  headers.set("content-type", MIME[ext] ?? "application/octet-stream");
  if (ext === ".pdf" && envBool("REPORTS_PUBLIC", true)) {
    headers.set("cache-control", "no-store");
  }
  return new Response(file, { headers });
}

function extname(p: string) {
  const i = p.lastIndexOf(".");
  if (i === -1) return "";
  return p.slice(i).toLowerCase();
}

