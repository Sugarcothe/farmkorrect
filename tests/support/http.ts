import type { ApiResult } from "@/lib/auth/types";

export const ORIGIN = "http://localhost:3000";

type Handler = (request: Request) => Promise<Response>;

export type CallOptions = {
  body?: unknown;
  rawBody?: string;
  cookie?: string | null;
  /** null omits the Origin header */
  origin?: string | null;
  /** null omits the Content-Type header */
  contentType?: string | null;
  ip?: string;
  method?: string;
};

export type CallResult<T> = {
  status: number;
  json: ApiResult<T>;
  headers: Headers;
  /** the session cookie value the response set ("" when cleared), if any */
  sessionCookie: string | undefined;
  setCookie: string | null;
};

/** Calls a route handler directly, the way a same-origin browser fetch would. */
export async function call<T = unknown>(
  handler: Handler,
  path: string,
  options: CallOptions = {},
): Promise<CallResult<T>> {
  const method =
    options.method ?? (options.body !== undefined || options.rawBody !== undefined ? "POST" : "GET");
  const headers = new Headers();
  if (options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
  if (method !== "GET" && options.contentType !== null)
    headers.set("content-type", options.contentType ?? "application/json");
  if (options.cookie) headers.set("cookie", `fk_session=${options.cookie}`);
  headers.set("x-real-ip", options.ip ?? "203.0.113.10");

  const request = new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : (options.rawBody ?? JSON.stringify(options.body ?? {})),
  });
  const response = await handler(request);
  const setCookie = response.headers.get("set-cookie");
  const match = setCookie?.match(/^fk_session=([^;]*)/);
  return {
    status: response.status,
    json: (await response.json()) as ApiResult<T>,
    headers: response.headers,
    sessionCookie: match ? match[1] : undefined,
    setCookie,
  };
}

/** Narrows a result to its data, failing the test if the call didn't succeed. */
export function dataOf<T>(result: CallResult<T>): T {
  if (!result.json.ok) throw new Error(`Expected success, got ${result.status}: ${result.json.error}`);
  return result.json.data;
}
