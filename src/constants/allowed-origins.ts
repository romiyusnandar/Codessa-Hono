/**
 * Origins allowed to (a) make credentialed cross-site requests (CORS, see index.ts) and
 * (b) be redirected back to after GitHub OAuth login (see routes/auth.ts). Single shared
 * list so both checks always agree — an origin should never be CORS-allowed but not a
 * valid login redirect target, or vice versa.
 */
export const ALLOWED_ORIGINS = [process.env.FRONTEND_URL, ...(process.env.ADDITIONAL_ALLOWED_ORIGINS?.split(",") ?? [])]
  .map((origin) => origin?.trim())
  .filter((origin): origin is string => Boolean(origin));
