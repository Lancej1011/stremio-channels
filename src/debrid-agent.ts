#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { logger, setRedaction } from "./log.ts";
import { secretFromEnv } from "./secrets.ts";
import { TorBoxClient } from "./content/providers/torbox.ts";
import { ClientRateLimiter, clientKey } from "./request-limits.ts";

const log = logger("debrid-agent");
const hashSchema = z.string().regex(/^[a-fA-F0-9]{32,64}$/).transform((v) => v.toLowerCase());

function authorized(req: FastifyRequest, expected: Buffer): boolean {
  const value = req.headers.authorization;
  if (!value?.startsWith("Bearer ")) return false;
  const actual = createHash("sha256").update(value.slice(7)).digest();
  return timingSafeEqual(actual, expected);
}

function deny(reply: FastifyReply) {
  return reply.code(404).type("text/plain").send("not found");
}

/** Builds the broker without binding a socket, so its complete boundary can be tested. */
export async function buildDebridAgent(
  apiKey: string,
  agentToken: string,
  operationLimitPerMinute = 300,
) {
  if (agentToken.length < 24) throw new Error("DEBRID_AGENT_TOKEN must be at least 24 characters");
  const expected = createHash("sha256").update(agentToken).digest();
  const torbox = new TorBoxClient(apiKey);
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  await app.register(rateLimit, {
    global: true,
    max: operationLimitPerMinute,
    timeWindow: "1 minute",
  });
  const authFailures = new ClientRateLimiter(20, 5 * 60_000, 15 * 60_000, 1_000);

  app.addHook("onRequest", async (req, reply) => {
    const key = clientKey(req.raw);
    if (authorized(req, expected)) {
      authFailures.reset(key);
      return;
    }
    const result = authFailures.hit(key);
    if (!result.allowed) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      reply.header("Connection", "close");
    }
    return deny(reply);
  });

  app.post("/v1/verify", async () => ({ ok: await torbox.verify() }));

  app.post<{ Body: unknown }>("/v1/check-cached", async (req, reply) => {
    const parsed = z.object({
      hashes: z.array(hashSchema).min(1).max(100),
      withFiles: z.boolean().default(true),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request" });
    const found = await torbox.checkCached(parsed.data.hashes, parsed.data.withFiles);
    return { torrents: [...found.values()] };
  });

  app.post<{ Body: unknown }>("/v1/add-magnet", async (req, reply) => {
    const parsed = z.object({ hash: hashSchema }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request" });
    return { torrentId: await torbox.addMagnet(parsed.data.hash) };
  });

  app.post<{ Body: unknown }>("/v1/torrent-files", async (req, reply) => {
    const parsed = z.object({ torrentId: z.number().int().positive() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request" });
    return { files: await torbox.torrentFiles(parsed.data.torrentId) };
  });

  app.post<{ Body: unknown }>("/v1/download-link", async (req, reply) => {
    const parsed = z.object({
      torrentId: z.number().int().positive(),
      fileId: z.number().int().nonnegative(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request" });
    return { url: await torbox.downloadLink(parsed.data.torrentId, parsed.data.fileId) };
  });

  app.setErrorHandler((err, _req, reply) => {
    const statusCode = typeof err === "object" && err !== null && "statusCode" in err
      ? (err as { statusCode?: unknown }).statusCode
      : undefined;
    if (statusCode === 429) {
      return reply.code(429).send({ error: "too many provider requests" });
    }
    log.error("provider request failed", err);
    return reply.code(502).send({ error: "provider request failed" });
  });
  return app;
}

async function main(): Promise<void> {
  const apiKey = secretFromEnv("TORBOX_API_KEY");
  const token = secretFromEnv("DEBRID_AGENT_TOKEN");
  if (!apiKey) throw new Error("TORBOX_API_KEY or TORBOX_API_KEY_FILE is required");
  if (!token) throw new Error("DEBRID_AGENT_TOKEN or DEBRID_AGENT_TOKEN_FILE is required");

  // Install redaction before the first network operation or log line.
  setRedaction([apiKey, token]);
  const host = process.env.DEBRID_AGENT_HOST?.trim() || "127.0.0.1";
  const port = Number(process.env.DEBRID_AGENT_PORT || 7665);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("DEBRID_AGENT_PORT must be a valid TCP port");
  }
  const app = await buildDebridAgent(apiKey, token);
  await app.listen({ host, port });
  log.info(`listening on ${host}:${port}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    log.error("failed to start", err);
    process.exitCode = 1;
  });
}
