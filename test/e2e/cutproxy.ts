// A small HTTP proxy in front of the app that can cut the live-update channel
// (the SSE streams and their polling fallback) while ordinary requests keep
// working. Used by the realtime journey (brief 31 scenario 12): browser
// offline emulation does not close an EventSource that is already open.
//
// The Host header is passed through unchanged, so the app's same-origin checks
// see the address the browser used. Cookies are per host, not per port, so a
// browser signed in through http://localhost:<proxy> shares its session with
// http://localhost:<app>. WebSocket upgrades (Vite's HMR) are piped as-is.
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';

export interface CutProxy {
  base: string;
  /** true: drop open live streams and fail new live requests at the network level. */
  cut: (on: boolean) => void;
  close: () => Promise<void>;
}

const LIVE = /^\/api\/(staff|guest)\/events(\/|\?|$)/;

export async function startCutProxy(target: string): Promise<CutProxy> {
  const t = new URL(target);
  const sockets = new Set<Socket>();
  const live = new Set<ServerResponse>();
  let cut = false;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const isLive = LIVE.test(req.url ?? '');
    if (cut && isLive) {
      // A network failure, not an HTTP error: what a dropped Wi-Fi looks like.
      req.socket.destroy();
      return;
    }
    const up = request({ host: t.hostname, port: t.port, method: req.method, path: req.url, headers: req.headers }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
      if (isLive) {
        live.add(res);
        res.on('close', () => live.delete(res));
      }
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => up.destroy());
    req.pipe(up);
  });

  server.on('upgrade', (req: IncomingMessage, client: Socket, head: Buffer) => {
    const upstream = connect(Number(t.port), t.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const end = () => { upstream.destroy(); client.destroy(); };
    upstream.on('error', end);
    client.on('error', end);
    client.on('close', end);
    upstream.on('close', end);
  });

  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };

  return {
    base: `http://localhost:${port}`,
    cut: (on) => {
      cut = on;
      if (on) for (const r of live) r.socket?.destroy();
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
