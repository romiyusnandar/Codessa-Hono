import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { verify } from "hono/jwt";

export type AuthVariables = {
  userId: string;
};

export const requireAuth: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const token = getCookie(c, "session");
  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const payload = await verify(token, process.env.JWT_SECRET ?? "", "HS256");
    c.set("userId", payload.sub as string);
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
};
