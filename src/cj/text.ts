/** Small text helpers shared by the mapper. */

const BLOCK_TAGS = /<\/(p|div|li|tr|h[1-6]|blockquote|section|article)>/gi;
const BR_TAGS = /<br\s*\/?>/gi;
const LI_OPEN = /<li[^>]*>/gi;
const TAGS = /<[^>]+>/g;

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
  "&apos;": "'", "&nbsp;": " ", "&ndash;": "–", "&mdash;": "—",
  "&hellip;": "…", "&trade;": "™", "&reg;": "®", "&copy;": "©",
};

/** HTML -> single-line plain text. CJ reads `description` as text, not markup. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(BR_TAGS, " ")
    .replace(LI_OPEN, " • ")
    .replace(BLOCK_TAGS, " ")
    .replace(TAGS, " ")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? " ")
    // Delimited feeds break on raw newlines; CJ reads the file line by line.
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Truncate on a word boundary where possible; never mid-surrogate. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = Array.from(value).slice(0, max).join("");
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/**
 * CJ prices: plain decimal with '.' as the decimal separator, 2 places.
 * A ',' anywhere would be read as a decimal point, so thousands separators
 * must never reach the file.
 */
export function money(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return n.toFixed(2);
}

/** GTINs are 8, 10, 11, 12, 13 or 14 digits. Anything else CJ drops. */
export function normalizeGtin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return [8, 10, 11, 12, 13, 14].includes(digits.length) ? digits : null;
}

export function appendQuery(url: string, query?: string | null): string {
  if (!query) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${query.replace(/^[?&]/, "")}`;
}

export function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
