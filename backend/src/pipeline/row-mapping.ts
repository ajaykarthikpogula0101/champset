/**
 * Generic row-mapping layer. Pure functions — no Convex, no HTTP, no
 * subject knowledge.
 *
 * Resolves extracted data items into typed rows that match a dataset's
 * column declarations.
 */

export type ColumnType = "text" | "number" | "boolean" | "url" | "date";

export interface Column {
  name: string;
  type: ColumnType;
  isPrimaryKey?: boolean;
}

interface MapOptions {
  fieldMap?: Record<string, string>;
  constants?: Record<string, string>;
}

interface MapResult {
  data: Record<string, unknown>;
  missingKeys: string[];
}

/**
 * Coerce a raw value to the declared column type.
 *
 * Returns `undefined` when the value can't be represented as that type
 * (caller treats it as missing rather than writing garbage).
 *
 * Dates already in YYYY-MM-DD stay verbatim — don't let Date() shift
 * them across timezones.
 */
export function coerce(
  value: unknown,
  columnType: ColumnType,
): string | number | boolean | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }

  const str = String(value).trim();
  if (str === "") return undefined;

  switch (columnType) {
    case "text":
      return str;

    case "number": {
      // Strip common non-numeric characters (commas, currency symbols)
      const cleaned = str.replace(/[,$€£¥%\s]/g, "");
      const num = Number(cleaned);
      return Number.isFinite(num) ? num : undefined;
    }

    case "boolean": {
      const lower = str.toLowerCase();
      if (["true", "yes", "1", "on"].includes(lower)) return true;
      if (["false", "no", "0", "off", ""].includes(lower)) return false;
      return undefined;
    }

    case "url": {
      try {
        const u = new URL(str);
        if (u.protocol === "http:" || u.protocol === "https:") {
          return u.href;
        }
        return undefined;
      } catch {
        return undefined;
      }
    }

    case "date": {
      // Already YYYY-MM-DD — keep verbatim
      if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
        return str;
      }
      // Try parsing as a date and format as YYYY-MM-DD
      try {
        const d = new Date(str);
        if (Number.isNaN(d.getTime())) return undefined;
        // Use UTC to avoid timezone shifts
        const year = d.getUTCFullYear();
        const month = String(d.getUTCMonth() + 1).padStart(2, "0");
        const day = String(d.getUTCDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
      } catch {
        return undefined;
      }
    }

    default:
      return undefined;
  }
}

/**
 * Resolve a single column's value from an extracted item.
 *
 * Resolution order:
 *   1. Explicit field_map entry for this column
 *   2. Exact key match (case-sensitive)
 *   3. Case/separator-insensitive match (e.g. "Event Name", "event-name",
 *      "eventName" all reach an "event_name" column)
 *
 * Returns { value, resolved } where resolved is the source key that matched
 * (or undefined if nothing matched).
 */
function resolveColumnValue(
  column: Column,
  item: Record<string, unknown>,
  fieldMap?: Record<string, string>,
): { value: unknown; resolved: string | undefined } {
  // 1. Explicit field_map
  if (fieldMap && column.name in fieldMap) {
    const sourceKey = fieldMap[column.name];
    return { value: item[sourceKey], resolved: sourceKey };
  }

  // 2. Exact match
  if (column.name in item) {
    return { value: item[column.name], resolved: column.name };
  }

  // 3. Case/separator-insensitive match
  const normalizedTarget = column.name
    .toLowerCase()
    .replace(/[_\-\s]+/g, "");

  for (const key of Object.keys(item)) {
    const normalizedKey = key.toLowerCase().replace(/[_\-\s]+/g, "");
    if (normalizedKey === normalizedTarget) {
      return { value: item[key], resolved: key };
    }
  }

  return { value: undefined, resolved: undefined };
}

/**
 * Map an extracted item to a row matching the dataset's columns.
 *
 * Writes ONLY declared columns; drops stray keys. Constants are applied
 * last and win over extracted values.
 *
 * Returns `{ data, missingKeys }` where `missingKeys` lists isPrimaryKey
 * columns that came back empty after coercion.
 */
export function mapItemToRow(
  item: Record<string, unknown>,
  columns: Column[],
  options: MapOptions = {},
): MapResult {
  const data: Record<string, unknown> = {};
  const missingKeys: string[] = [];

  for (const column of columns) {
    const { value } = resolveColumnValue(column, item, options.fieldMap);
    const coerced = coerce(value, column.type);

    if (coerced !== undefined) {
      data[column.name] = coerced;
    } else if (options.constants && column.name in options.constants) {
      // Constants are applied last and win
      const constantValue = options.constants[column.name];
      const coercedConstant = coerce(constantValue, column.type);
      if (coercedConstant !== undefined) {
        data[column.name] = coercedConstant;
      }
    }

    // Track missing primary keys
    if (column.isPrimaryKey && !(column.name in data)) {
      missingKeys.push(column.name);
    }
  }

  return { data, missingKeys };
}

/**
 * Check if a row has all primary keys populated and at least one cell
 * populated overall.
 */
export function isWritableRow(row: Record<string, unknown>): boolean {
  const hasAnyValue = Object.values(row).some(
    (v) => v !== undefined && v !== null && v !== "",
  );
  if (!hasAnyValue) return false;
  return true;
}

