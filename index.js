'use strict';

const net = require('node:net');
const { Server } = require('node:http');
const attached = new WeakSet();

function target(authority) {
  if (typeof authority !== 'string') return null;
  const match = /^(?:\[([^\]]+)\]|([^:\[\]]+)):([0-9]+)$/.exec(authority);
  if (!match) return null;
  const host = match[1] || match[2];
  const port = Number(match[3]);
  if (port < 1 || port > 65535) return null;
  if (match[1]) {
    if (net.isIP(host) !== 6) return null;
  } else if (!net.isIP(host)) {
    // DNS names only: no URL syntax, whitespace, credentials or escapes.
    const name = host.endsWith('.') ? host.slice(0, -1) : host;
    if (name.length > 253 || !name.split('.').every(label =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null;
  }
  return { host, port };
}

function attach(server) {
  if (!(server instanceof Server)) {
    throw new TypeError('attach() requires a Node HTTP server');
  }
  if (attached.has(server) || server.listenerCount('connect')) {
    throw new Error('The server already has a CONNECT handler');
  }

  function connect(request, client, head) {
    client.pause();
    let upstream;
    let established = false;
    let failed = false;
    function destroy() {
      if (upstream) upstream.destroy();
      client.destroy();
    }
    function reject(code, reason) {
      if (failed) return;
      failed = true;
      if (upstream) upstream.destroy();
      if (established || !client.writable) return destroy();
      client.end(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      // Do not retain a paused readable socket after sending a rejection.
      client.once('finish', () => client.destroy());
    }
    client.on('error', destroy);
    client.once('close', () => { if (upstream) upstream.destroy(); });
    const destination = target(request.url);
    if (!destination) return reject(400, 'Bad Request');

    try {
      // Allow TCP half-closes so a destination can finish replying after EOF.
      upstream = net.connect({ ...destination, allowHalfOpen: true });
      upstream.on('error', () => reject(502, 'Bad Gateway'));
      upstream.once('close', () => {
        if (established && !client.destroyed && !upstream.readableEnded) client.destroy();
      });
      upstream.once('connect', () => {
        if (failed || client.destroyed) return upstream.destroy();
        established = true;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(client);
        function relay() {
          if (!client.destroyed && !upstream.destroyed) client.pipe(upstream);
        }
        if (head.length && !upstream.write(head)) upstream.once('drain', relay);
        else relay();
      });
    } catch {
      reject(502, 'Bad Gateway');
    }
  }

  server.on('connect', connect);
  attached.add(server);
  let detached = false;
  return function detach() {
    if (detached) return;
    detached = true;
    server.off('connect', connect);
    attached.delete(server);
  };
}

module.exports = { attach };

