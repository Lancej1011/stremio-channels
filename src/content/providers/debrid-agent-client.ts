import { z } from "zod";
import { logger } from "../../log.ts";
import type { CachedTorrent, TorBoxApi, UserTorrentFile } from "./torbox.ts";

const log = logger("debrid-agent");

const cachedTorrentSchema = z.object({
  hash: z.string(),
  name: z.string(),
  size: z.number(),
  files: z.array(z.object({ id: z.number(), name: z.string(), size: z.number() })).optional(),
});

const userFileSchema = z.object({ id: z.number(), name: z.string(), size: z.number() });

/**
 * A narrow client for the local credential broker. The bearer token authorizes use of
 * the broker but is not a TorBox credential and can be rotated without touching the
 * provider account.
 */
export class DebridAgentClient implements TorBoxApi {
  private readonly base: string;

  constructor(url: string, private readonly token: string) {
    this.base = url.replace(/\/$/, "");
  }

  private async call(path: string, body: unknown): Promise<unknown> {
    try {
      const res = await fetch(`${this.base}/v1/${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`agent returned ${res.status}`);
      return await res.json();
    } catch (err) {
      // Never include the configured URL or token: URLs can themselves carry credentials,
      // and this error commonly lands in support logs.
      throw new Error(`debrid agent ${path} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  async verify(): Promise<boolean> {
    try {
      const data = z.object({ ok: z.boolean() }).parse(await this.call("verify", {}));
      return data.ok;
    } catch (err) {
      log.warn("credential verification failed", err instanceof Error ? err.message : err);
      return false;
    }
  }

  async checkCached(hashes: string[], withFiles = true): Promise<Map<string, CachedTorrent>> {
    const data = z.object({ torrents: z.array(cachedTorrentSchema) }).parse(
      await this.call("check-cached", { hashes, withFiles }),
    );
    return new Map(data.torrents.map((item) => [item.hash.toLowerCase(), item]));
  }

  async addMagnet(hash: string): Promise<number | null> {
    const data = z.object({ torrentId: z.number().int().positive().nullable() }).parse(
      await this.call("add-magnet", { hash }),
    );
    return data.torrentId;
  }

  async torrentFiles(torrentId: number): Promise<UserTorrentFile[]> {
    const data = z.object({ files: z.array(userFileSchema) }).parse(
      await this.call("torrent-files", { torrentId }),
    );
    return data.files;
  }

  async downloadLink(torrentId: number, fileId: number): Promise<string | null> {
    const data = z.object({ url: z.string().url().nullable() }).parse(
      await this.call("download-link", { torrentId, fileId }),
    );
    return data.url;
  }
}
