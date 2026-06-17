import { createHmac, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

export type WebhookVariables = {
  rawBody: string;
};

export const verifyGithubSignature = (secret: string): MiddlewareHandler<{ Variables: WebhookVariables }> => {
  return async (c, next) => {
    const signature = c.req.header("x-hub-signature-256");
    if (!signature) {
      return c.json({ error: "Missing signature" }, 401);
    }

    const rawBody = await c.req.text();
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expected);
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    c.set("rawBody", rawBody);
    await next();
  };
};
