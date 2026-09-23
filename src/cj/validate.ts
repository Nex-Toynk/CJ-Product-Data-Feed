import { CJ_FIELD_BY_NAME, CJ_FIELDS, ID_ALLOWED } from "./spec";
import type { CjRow, RowIssue } from "./types";

/**
 * Last-line check before a feed leaves the app: catches anything the mapper's
 * overrides could have broken. CJ's own import report is the authority, but
 * this stops obviously-doomed files from being delivered at all.
 */
export function validateRows(columns: string[], rows: CjRow[]): RowIssue[] {
  const issues: RowIssue[] = [];
  const push = (i: RowIssue) => {
    if (issues.length < 1000) issues.push(i);
  };

  const missingRequired = CJ_FIELDS.filter(
    (f) => f.requirement === "required" && !columns.includes(f.name),
  );
  for (const f of missingRequired) {
    push({ id: "<feed>", field: f.name, level: "reject", stage: "validate", message: "Required column missing from header" });
  }
  if (!columns.some((c) => c.startsWith("shipping("))) {
    push({ id: "<feed>", field: "shipping", level: "reject", stage: "validate", message: "Required shipping column missing from header" });
  }

  const seen = new Set<string>();

  for (const row of rows) {
    const id = row.id ?? "<no id>";

    if (seen.has(id)) {
      push({ id, field: "id", level: "reject", stage: "validate", message: "Duplicate id in feed" });
    }
    seen.add(id);

    if (ID_ALLOWED.test(id)) {
      ID_ALLOWED.lastIndex = 0;
      push({ id, field: "id", level: "reject", stage: "validate", message: "id contains characters CJ rejects" });
    }
    ID_ALLOWED.lastIndex = 0;

    for (const col of columns) {
      const spec = CJ_FIELD_BY_NAME.get(col);
      if (!spec) continue;
      const value = row[col] ?? "";

      if (spec.requirement === "required" && !value) {
        push({ id, field: col, level: "reject", stage: "validate", message: "Required value is empty" });
        continue;
      }
      if (!value) continue;

      if (spec.maxLength && value.length > spec.maxLength) {
        push({
          id, field: col, level: "warn", stage: "validate",
          message: `${value.length} chars exceeds CJ's ${spec.maxLength} limit`,
        });
      }
      if (spec.enum && !spec.enum.includes(value)) {
        push({
          id, field: col,
          level: spec.rejectsRow ? "reject" : "warn",
          stage: "validate",
          message: `"${value}" is not one of: ${spec.enum.join(", ")}`,
        });
      }
      if ((col === "link" || col === "image_link" || col === "mobile_link") && !/^https?:\/\//i.test(value)) {
        push({ id, field: col, level: "reject", stage: "validate", message: "URL must start with http:// or https://" });
      }
      if ((col === "price" || col === "sale_price") && !/^\d+\.\d{2}( [A-Z]{3})?$/.test(value)) {
        push({ id, field: col, level: "reject", stage: "validate", message: `"${value}" is not a plain decimal price` });
      }
      if (col === "gtin" && !/^\d{8}$|^\d{10,14}$/.test(value)) {
        push({ id, field: col, level: "warn", stage: "validate", message: "GTIN must be 8, 10, 11, 12, 13 or 14 digits" });
      }
    }
  }

  return issues;
}

export function summarize(issues: RowIssue[]) {
  const rejects = issues.filter((i) => i.level === "reject");
  const warnings = issues.filter((i) => i.level === "warn");
  const byField = new Map<string, number>();
  for (const i of issues) byField.set(i.field, (byField.get(i.field) ?? 0) + 1);
  return {
    rejectCount: rejects.length,
    warnCount: warnings.length,
    topFields: [...byField.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
  };
}
