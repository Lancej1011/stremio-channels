import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { fetchGuideBundle, isNonPublicAddress, MAX_GUIDE_BYTES } from "./guide-import.ts";

describe("guide URL network policy", () => {
  it("classifies local, private, link-local, reserved, and metadata addresses", () => {
    for (const address of [
      "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254",
      "172.16.0.1", "192.168.1.1", "198.18.0.1", "224.0.0.1", "::", "::1",
      "fd00::1", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1",
    ]) assert.equal(isNonPublicAddress(address), true, address);

    for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"]) {
      assert.equal(isNonPublicAddress(address), false, address);
    }
  });

  describe("pinned local test server", () => {
    const server = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/guide" }).end();
      } else if (req.url === "/loop") {
        res.writeHead(302, { location: "/loop" }).end();
      } else if (req.url === "/large") {
        res.writeHead(200, { "content-length": String(MAX_GUIDE_BYTES + 1) }).end("{}");
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end('{"safe":true}');
      }
    });
    let base = "";

    before(async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind");
      base = `http://127.0.0.1:${address.port}`;
    });
    after(async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    });

    it("blocks private destinations by default", async () => {
      await assert.rejects(
        fetchGuideBundle(`${base}/guide`, { allowPrivate: false }),
        /private or local/,
      );
    });

    it("allows an explicit LAN override and validates relative redirects", async () => {
      assert.deepEqual(
        await fetchGuideBundle(`${base}/redirect`, { allowPrivate: true }),
        { safe: true },
      );
    });

    it("bounds redirects and response size", async () => {
      await assert.rejects(
        fetchGuideBundle(`${base}/loop`, { allowPrivate: true }),
        /redirected too many times/,
      );
      await assert.rejects(
        fetchGuideBundle(`${base}/large`, { allowPrivate: true }),
        /too large/,
      );
    });

    it("rejects credentials embedded in a URL", async () => {
      await assert.rejects(
        fetchGuideBundle(base.replace("http://", "http://user:pass@"), { allowPrivate: true }),
        /must not contain credentials/,
      );
    });
  });
});
