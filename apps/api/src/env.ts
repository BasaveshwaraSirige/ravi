type EnvValue = string | undefined;

export async function loadDotEnv(dotEnvPath = ".env") {
  const file = Bun.file(dotEnvPath);
  if (!(await file.exists())) return;
  const t = await file.text();
  for (const rawLine of t.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function env(name: string, fallback?: string): string {
  const v: EnvValue = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing env var: ${name}`);
  }
  return v;
}

export function envOptional(name: string): string | undefined {
  const v: EnvValue = process.env[name];
  if (v === undefined || v === "") return undefined;
  return v;
}

export function envBool(name: string, fallback = false): boolean {
  const v = envOptional(name);
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export function envInt(name: string, fallback: number): number {
  const v = envOptional(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

