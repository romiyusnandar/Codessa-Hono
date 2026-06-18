import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { swaggerUI } from "@hono/swagger-ui";

export const docsRoute = new Hono();

docsRoute.get("/openapi.json", (c) => {
  const spec = JSON.parse(readFileSync(join(process.cwd(), "openapi.json"), "utf-8"));
  return c.json(spec);
});

docsRoute.get("/docs", swaggerUI({ url: "/openapi.json" }));
