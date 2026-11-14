// Keys whose values describe a response's shape rather than what someone wrote.
const SHAPE_KEY = /^(id|ids|type|rawType|kind|documentType|mimeType|mime_type|contentType|content_type|uti|created|jsonrpc)$|(_id|Id|_ids|Ids|_at|At|_error)$/;

/**
 * A copy of an Allume response that is safe to share in a bug report: keys,
 * ids, types, dates, numbers and booleans stay; any other string becomes its
 * length. JSON inside a string (MCP text blocks) is redacted the same way.
 */
export function redact(v: unknown, key = ""): unknown {
  if (typeof v === "string") {
    if (/^\s*[[{]/.test(v)) {
      try {
        return JSON.stringify(redact(JSON.parse(v), key));
      } catch {
        /* not JSON */
      }
    }
    return SHAPE_KEY.test(key) ? v : `‹${v.length} chars›`;
  }
  if (Array.isArray(v)) return v.map((x) => redact(x, key));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k)]));
  }
  return v;
}
