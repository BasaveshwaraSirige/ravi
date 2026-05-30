export type ProductCategory =
  | "WHISKEY"
  | "BRANDY"
  | "RUM"
  | "BEER"
  | "GIN"
  | "VODKA"
  | "WINE"
  | "CARBONATED_WINE"
  | "OTHERS";

const PRODUCT_CATEGORY_SET = new Set<ProductCategory>([
  "WHISKEY",
  "BRANDY",
  "RUM",
  "BEER",
  "GIN",
  "VODKA",
  "WINE",
  "CARBONATED_WINE",
  "OTHERS"
]);

export function normalizeCategory(raw: any): ProductCategory {
  const s = String(raw ?? "").trim();
  if (!s) return "OTHERS";
  const key = s.toUpperCase().replace(/[\s-]+/g, "_");
  if (PRODUCT_CATEGORY_SET.has(key as ProductCategory)) return key as ProductCategory;
  if (key === "WHISKY") return "WHISKEY";
  if (key === "OTHER") return "OTHERS";
  return "OTHERS";
}

export function inferCategoryFromName(rawName: any): ProductCategory | null {
  const name = String(rawName ?? "").toUpperCase();
  if (!name) return null;

  if (/\bCARBONATED[\s_-]*WINE\b/.test(name)) return "CARBONATED_WINE";
  // Common carbonated-wine brand names that don't contain "WINE".
  if (/\bBRO\s*CODE\b/.test(name) || /\bBIG\s*BRO\b/.test(name)) return "CARBONATED_WINE";

  if (/\bVODKA\b/.test(name)) return "VODKA";
  if (/\bWHISKY\b/.test(name) || /\bWHISKEY\b/.test(name)) return "WHISKEY";
  if (/\bBRANDY\b/.test(name)) return "BRANDY";
  if (/\bRUM\b/.test(name)) return "RUM";
  if (/\bBEER\b/.test(name)) return "BEER";
  if (/\bGIN\b/.test(name)) return "GIN";
  if (/\bWINE\b/.test(name)) return "WINE";

  return null;
}

const COMMON_SIZE_ML = new Set<number>([
  50,
  60,
  90,
  150,
  180,
  200,
  275,
  330,
  375,
  500,
  650,
  700,
  750,
  1000,
  2000
]);

export function inferSizeFromName(rawName: any, categoryHint?: ProductCategory | null): string | null {
  const name = String(rawName ?? "").toUpperCase();
  if (!name) return null;

  if (/\bPINT\b/.test(name)) return categoryHint === "BEER" ? "330 PINT" : "330 PINT";

  const mlMatch = name.match(/\b(\d{2,4})\s*ML/);
  const trailingMatch = name.match(/\b(\d{2,4})\b\s*$/);
  const nRaw = mlMatch?.[1] ?? trailingMatch?.[1] ?? "";
  const n = Number.parseInt(nRaw, 10);
  if (!Number.isFinite(n) || !COMMON_SIZE_ML.has(n)) return null;

  if (categoryHint === "BEER") {
    if (n === 500) return "500 TIN";
    if (n === 330) return "330 TIN";
    if (n === 650) return "650ML";
    if (n === 275) return "275ML";
    return null;
  }

  return `${n}ML`;
}

export const GENERAL_SIZES = [
  "1 Litre",
  "2 Litre",
  "1000ML",
  "750ML",
  "700ML",
  "650ML",
  "500ML",
  "375ML",
  "330ML",
  "275ML",
  "200ML",
  "180ML",
  "150ML",
  "90ML",
  "60ML",
  "50ML"
] as const;

export const BEER_SIZES = ["650ML", "500 TIN", "330 TIN", "330 PINT", "275ML"] as const;

const GENERAL_SIZE_SET = new Set<string>(GENERAL_SIZES);
const BEER_SIZE_SET = new Set<string>(BEER_SIZES);

function sizeKey(s: string) {
  return s
    .toUpperCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/(\d)\s+ML\b/g, "$1ML");
}

const SIZE_CANON = new Map<string, string>(
  [...GENERAL_SIZES, ...BEER_SIZES].map((s) => [sizeKey(s), s])
);

export function canonicalSize(raw: any): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  return SIZE_CANON.get(sizeKey(s)) ?? null;
}

export function isValidSizeForCategory(category: ProductCategory, size: string | null) {
  if (!size) return false;
  return category === "BEER" ? BEER_SIZE_SET.has(size) : GENERAL_SIZE_SET.has(size);
}

export function defaultSizeForCategory(category: ProductCategory) {
  return category === "BEER" ? "650ML" : "750ML";
}

export function normalizeSize(category: ProductCategory, raw: any): string {
  const canon = canonicalSize(raw);
  if (canon && isValidSizeForCategory(category, canon)) return canon;
  return defaultSizeForCategory(category);
}

export function normalizeBottlesPerCase(
  category: ProductCategory,
  size: string | null,
  raw: any
): number {
  if (size === "90ML") return 96;
  if (category === "BEER" && size === "650ML") return 12;
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 12;
}
