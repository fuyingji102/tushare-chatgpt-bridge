export type Row = Record<string, unknown>;

export class TushareError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "TushareError";
    this.code = code;
  }
}

export async function tushareQuery(
  apiName: string,
  params: Record<string, unknown> = {},
  fields = "",
): Promise<Row[]> {
  const token = process.env.TUSHARE_TOKEN?.trim();
  if (!token) throw new TushareError("TUSHARE_TOKEN is not configured");

  const response = await fetch("https://api.tushare.pro", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_name: apiName, token, params, fields }),
  });

  if (!response.ok) {
    throw new TushareError(`Tushare HTTP ${response.status}`);
  }

  const body = await response.json() as {
    code?: number;
    msg?: string;
    data?: { fields?: string[]; items?: unknown[][] };
  };

  if (body.code !== undefined && body.code !== 0) {
    throw new TushareError(body.msg || "Tushare returned an error", body.code);
  }

  const cols = body.data?.fields || [];
  const items = body.data?.items || [];
  return items.map((item) => Object.fromEntries(cols.map((c, i) => [c, item[i]])));
}

export function n(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
}

export function s(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

export function sortNumeric(rows: Row[], field: string, desc = true): Row[] {
  return [...rows].sort((a, b) => {
    const av = n(a[field]);
    const bv = n(b[field]);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return desc ? bv - av : av - bv;
  });
}

export function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
