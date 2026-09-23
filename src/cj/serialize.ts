import type { CjRow } from "./types";

export type Delimiter = "," | "\t" | "|";

export const DELIMITER_BY_FORMAT: Record<string, Delimiter> = {
  CSV: ",",
  TSV: "\t",
  PIPE: "|",
};

/**
 * CJ's "Quoted Values = yes" setting means quotation marks delimit fields.
 * With it on we must quote anything containing the delimiter, a quote or a
 * newline, and escape inner quotes by doubling them.
 */
function escapeDelimited(value: string, delimiter: Delimiter, quoted: boolean): string {
  const v = value ?? "";
  if (!quoted) {
    // Without quoting there is no way to carry a delimiter or a line break
    // inside a value, so they are replaced with a space and the resulting run
    // of whitespace is collapsed so the value still reads cleanly.
    const pattern = delimiter === "\t" ? "\\t" : `\\${delimiter}`;
    return v
      .replace(new RegExp(`[${pattern}\\r\\n]`, "g"), " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  const needsQuotes = v.includes(delimiter) || v.includes('"') || /[\r\n]/.test(v);
  return needsQuotes ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toDelimited(
  columns: string[],
  rows: CjRow[],
  delimiter: Delimiter,
  quoted = true,
): string {
  const lines: string[] = [];
  lines.push(columns.map((c) => escapeDelimited(c, delimiter, quoted)).join(delimiter));
  for (const row of rows) {
    lines.push(
      columns.map((c) => escapeDelimited(row[c] ?? "", delimiter, quoted)).join(delimiter),
    );
  }
  // Trailing newline: some FTP fetchers drop the last line without it.
  return lines.join("\n") + "\n";
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
};

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

/**
 * CJ's Shopping feed in XML is the Google Merchant RSS 2.0 shape: each product
 * is an <item> and attributes live in the `g:` namespace. Compound fields
 * (shipping, tax) nest their sub-attributes instead of using the
 * `field(sub:sub)` header syntax used in delimited files.
 */
export function toXml(
  columns: string[],
  rows: CjRow[],
  meta: { title: string; link: string; description: string },
): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">');
  out.push("  <channel>");
  out.push(`    <title>${escapeXml(meta.title)}</title>`);
  out.push(`    <link>${escapeXml(meta.link)}</link>`);
  out.push(`    <description>${escapeXml(meta.description)}</description>`);

  const compound = columns.filter((c) => c.includes("("));
  const simple = columns.filter((c) => !c.includes("("));

  for (const row of rows) {
    out.push("    <item>");
    for (const col of simple) {
      const value = row[col];
      if (!value) continue;
      out.push(`      <g:${col}>${escapeXml(value)}</g:${col}>`);
    }
    for (const col of compound) {
      const value = row[col];
      if (!value) continue;
      const name = col.slice(0, col.indexOf("("));
      const subattrs = col.slice(col.indexOf("(") + 1, col.lastIndexOf(")")).split(":");
      const values = value.split(":");
      const parts = subattrs
        .map((sub, i) => ({ sub, val: values[i] ?? "" }))
        .filter((p) => p.val !== "");
      if (parts.length === 0) continue;
      out.push(`      <g:${name}>`);
      for (const p of parts) out.push(`        <g:${p.sub}>${escapeXml(p.val)}</g:${p.sub}>`);
      out.push(`      </g:${name}>`);
    }
    out.push("    </item>");
  }

  out.push("  </channel>");
  out.push("</rss>");
  return out.join("\n") + "\n";
}

export function contentTypeFor(format: string): string {
  switch (format) {
    case "XML": return "application/xml; charset=utf-8";
    case "TSV": return "text/tab-separated-values; charset=utf-8";
    case "PIPE": return "text/plain; charset=utf-8";
    default: return "text/csv; charset=utf-8";
  }
}
