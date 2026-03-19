export function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function extractArrayPayload(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  for (const key of keys) {
    const nested = (value as Record<string, unknown>)[key];
    if (Array.isArray(nested)) {
      return nested;
    }
    if (nested && typeof nested === "object") {
      for (const childKey of ["items", "results", "data"]) {
        const child = (nested as Record<string, unknown>)[childKey];
        if (Array.isArray(child)) {
          return child;
        }
      }
    }
  }
  return [];
}

export function extractObjectPayload(
  value: unknown,
  keys: string[],
): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of keys) {
      const nested = (value as Record<string, unknown>)[key];
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        return nested as Record<string, unknown>;
      }
    }
    return value as Record<string, unknown>;
  }
  return null;
}

export function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function uniqueStrings(values: string[], limit?: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (limit && result.length >= limit) {
      break;
    }
  }
  return result;
}
