// M0-4 spike: web-Response → node:http adapter so the handler runs without a
// server framework. M1-1 redoes this on Hono; only the AI SDK pieces survive.
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

const PASS_THROUGH_HEADERS = ["authorization", "content-type", "accept"];

export interface SpikeServer {
  url: string;
  close: () => Promise<void>;
}

export function startNodeServer(
  handler: (request: Request) => Promise<Response>,
): Promise<SpikeServer> {
  let port = 0;
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = `http://127.0.0.1:${port}${req.url ?? "/"}`;
      const headers: Record<string, string> = {};
      for (const name of PASS_THROUGH_HEADERS) {
        const value = req.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      // `duplex` is an undici extension, absent from the DOM RequestInit type.
      const init: RequestInit & { duplex?: "half" } = {
        method: req.method,
        headers,
        body:
          req.method === "GET" || req.method === "HEAD"
            ? undefined
            : (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>),
        duplex: "half",
      };
      const request = new Request(url, init);
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body) {
        await Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>).pipe(
          res,
        );
      } else {
        res.end();
      }
    })().catch((error) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(`spike server error: ${String(error)}`);
    });
  });

  const portP = new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      port = typeof address === "object" && address !== null ? address.port : 0;
      resolve(port);
    });
  });

  return portP.then((port) => ({
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  }));
}
