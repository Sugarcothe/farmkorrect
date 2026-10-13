import type {
  ApiResult,
  FarmResponse,
  FarmSetupRequest,
  LoginRequest,
  LoginResponse,
  NewPasswordRequest,
  PasswordResetRequest,
  RegisterRequest,
  RegisterResponse,
  ResendOtpRequest,
  SessionResponse,
  VerifyOtpRequest,
  VerifyOtpResponse,
} from "./types";

// Browser-side client for the app's own /api routes. Sessions are carried by
// the httpOnly cookie those routes set — never by anything in client storage.

const UNREACHABLE = "Can't reach the server. Check your connection and try again.";

export async function request<T>(path: string, init: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
  } catch {
    return { ok: false, error: UNREACHABLE };
  }

  const json = (await res.json().catch(() => null)) as ApiResult<T> | null;
  if (json && typeof json.ok === "boolean" && json.ok === res.ok) return json;
  return {
    ok: false,
    error: `Something went wrong (error ${res.status}). Please try again.`,
  };
}

const post = <T>(path: string, body: unknown) =>
  request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const register = (body: RegisterRequest) =>
  post<RegisterResponse>("/api/auth/register", body);

export const login = (body: LoginRequest) =>
  post<LoginResponse>("/api/auth/login", body);

export const logout = () => post<null>("/api/auth/logout", {});

export const getSession = () =>
  request<SessionResponse>("/api/auth/session", { method: "GET" });

export const verifyOtp = (body: VerifyOtpRequest) =>
  post<VerifyOtpResponse>("/api/auth/otp/verify", body);

export const resendOtp = (body: ResendOtpRequest) =>
  post<null>("/api/auth/otp/resend", body);

export const requestPasswordReset = (body: PasswordResetRequest) =>
  post<null>("/api/auth/password/forgot", body);

export const resetPassword = (body: NewPasswordRequest) =>
  post<null>("/api/auth/password/reset", body);

export const saveFarm = (body: FarmSetupRequest) =>
  post<FarmResponse>("/api/farms", body);
