import type {
  ApiResult,
  FarmSetupRequest,
  LoginRequest,
  PasswordResetRequest,
  RegisterRequest,
  ResendOtpRequest,
  VerifyOtpRequest,
} from "./types";

// Browser-side client for the app's own /api routes. Sessions are expected to
// be carried by httpOnly cookies set by those routes, never by client storage.

async function post<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
  } catch {
    return {
      ok: false,
      error: "Can't reach the server. Check your connection and try again.",
    };
  }

  const json = (await res.json().catch(() => null)) as ApiResult<T> | null;
  if (json && typeof json.ok === "boolean" && json.ok === res.ok) return json;
  return {
    ok: false,
    error: `Something went wrong (error ${res.status}). Please try again.`,
  };
}

export const register = (body: RegisterRequest) =>
  post("/api/auth/register", body);

export const login = (body: LoginRequest) => post("/api/auth/login", body);

export const verifyOtp = (body: VerifyOtpRequest) =>
  post("/api/auth/otp/verify", body);

export const resendOtp = (body: ResendOtpRequest) =>
  post("/api/auth/otp/resend", body);

export const requestPasswordReset = (body: PasswordResetRequest) =>
  post("/api/auth/password/forgot", body);

export const saveFarm = (body: FarmSetupRequest) => post("/api/farms", body);
