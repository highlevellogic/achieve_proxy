'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const proxy = require('..');

async function listen(server, host = '127.0.0.1') {
  server.listen(0, host);
  await once(server, 'listening');
  return server.address().port;
}
async function fixture(t, handler = socket => socket.pipe(socket), host) {
  const sockets = new Set();
  const destination = net.createServer({ allowHalfOpen: true }, handler);
  const server = http.createServer((req, res) => res.end('ordinary HTTP'));
  for (const item of [server, destination]) item.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  });
  const destinationPort = await listen(destination, host);
  const port = await listen(server);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([server, destination].map(item => new Promise(resolve => item.close(resolve))));
  });
  proxy.attach(server);
  return { server, port, destinationPort, sockets };
}
async function tunnel(port, authority, head = Buffer.alloc(0)) {
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  let response = Buffer.alloc(0);
  const ready = new Promise((resolve, reject) => {
    function data(chunk) {
      response = Buffer.concat([response, chunk]);
      const boundary = response.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      socket.off('data', data); socket.off('error', reject);
      socket.pause();
      const remainder = response.subarray(boundary + 4);
      if (remainder.length) socket.unshift(remainder);
      resolve({ socket, headers: response.subarray(0, boundary).toString() });
    }
    socket.on('data', data); socket.once('error', reject);
  });
  socket.write(Buffer.concat([Buffer.from(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`), head]));
  return ready;
}
function receive(socket, length) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    function data(chunk) {
      chunks.push(chunk); size += chunk.length;
      if (size >= length) { socket.off('data', data); resolve(Buffer.concat(chunks)); }
    }
    socket.on('data', data); socket.once('error', reject); socket.resume();
  });
}
async function ordinary(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, agent: false }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

test('HTTP and CONNECT coexist; head and large bidirectional payload survive', { timeout: 10000 }, async t => {
  const f = await fixture(t, socket => {
    socket.pipe(socket);
    socket.pause();
    setTimeout(() => socket.resume(), 50);
  });
  assert.equal(await ordinary(f.port), 'ordinary HTTP');
  const initial = Buffer.from('early tunnel bytes');
  const { socket, headers } = await tunnel(f.port, `127.0.0.1:${f.destinationPort}`, initial);
  assert.equal(headers, 'HTTP/1.1 200 Connection Established');
  assert.deepEqual(await receive(socket, initial.length), initial);
  assert.equal(await ordinary(f.port), 'ordinary HTTP');
  const payload = Buffer.alloc(16 * 1024 * 1024, 73);
  const received = receive(socket, payload.length);
  let backpressure = false;
  for (let offset = 0; offset < payload.length; offset += 65536) {
    if (!socket.write(payload.subarray(offset, offset + 65536))) {
      backpressure = true; await once(socket, 'drain');
    }
  }
  assert.equal(backpressure, true);
  assert.deepEqual(await received, payload);
  socket.end();
  await once(socket, 'close');
});

test('hostname and bracketed IPv6 targets', { timeout: 5000 }, async t => {
  const f = await fixture(t, undefined, 'localhost');
  const { socket, headers } = await tunnel(f.port, `localhost:${f.destinationPort}`);
  assert.match(headers, /^HTTP\/1.1 200/); socket.destroy();
  await t.test('IPv6 loopback', async t => {
    let v6;
    try { v6 = await fixture(t, undefined, '::1'); }
    catch (error) { if (['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) return t.skip('IPv6 unavailable'); throw error; }
    const result = await tunnel(v6.port, `[::1]:${v6.destinationPort}`);
    assert.match(result.headers, /^HTTP\/1.1 200/); result.socket.destroy();
  });
});

test('malformed authorities return 400', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  for (const authority of ['host', 'host:0', 'host:65536', 'host:abc', 'host:80/path', 'user@host:80', '[bad]:80', '::1:80', '-host:80', 'host:80?x']) {
    const { socket, headers } = await tunnel(f.port, authority);
    assert.match(headers, /^HTTP\/1.1 400/, authority);
    socket.resume(); await once(socket, 'close');
  }
});

test('refused destination returns 502', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const unused = net.createServer(); const port = await listen(unused);
  await new Promise(resolve => unused.close(resolve));
  const { socket, headers } = await tunnel(f.port, `127.0.0.1:${port}`);
  assert.match(headers, /^HTTP\/1.1 502/);
  socket.resume(); await once(socket, 'close');
});

test('client EOF permits final upstream reply; sockets close', { timeout: 5000 }, async t => {
  const f = await fixture(t, socket => {
    socket.resume(); socket.on('end', () => socket.end('final reply'));
  });
  const { socket } = await tunnel(f.port, `127.0.0.1:${f.destinationPort}`);
  const reply = receive(socket, 11); socket.end();
  assert.equal((await reply).toString(), 'final reply'); await once(socket, 'close');
});

test('destination failure and client abandonment clean up', { timeout: 5000 }, async t => {
  const f = await fixture(t, socket => {
    socket.on('data', () => socket.destroy());
    socket.on('end', () => socket.end());
  });
  const { socket } = await tunnel(f.port, `127.0.0.1:${f.destinationPort}`);
  socket.resume(); socket.write('close'); await once(socket, 'close');
  const abandoned = net.connect(f.port, '127.0.0.1'); await once(abandoned, 'connect');
  abandoned.write(`CONNECT 127.0.0.1:${f.destinationPort} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
  abandoned.destroy();
  const deadline = Date.now() + 2000;
  while (f.sockets.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.sockets.size, 0);
});

test('attachment ownership and detach', async t => {
  const f = await fixture(t);
  assert.throws(() => proxy.attach(f.server), /already/);
  const server = http.createServer(); const existing = () => {};
  server.on('connect', existing); assert.throws(() => proxy.attach(server), /already/);
  server.off('connect', existing);
  const detach = proxy.attach(server); assert.equal(server.listenerCount('connect'), 1);
  detach(); detach(); assert.equal(server.listenerCount('connect'), 0);
  proxy.attach(server);
  detach();
  assert.throws(() => proxy.attach(server), /already/);
  assert.throws(() => proxy.attach(null), TypeError);
});


test('client reset before destination connection destroys pending socket', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const client = new net.Socket();
  client.connect(f.port, '127.0.0.1'); await once(client, 'connect');
  const pending = new net.Socket();
  let started;
  const requested = new Promise(resolve => { started = resolve; });
  t.mock.method(net, 'connect', () => { started(); return pending; });
  client.write(`CONNECT 127.0.0.1:${f.destinationPort} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
  await requested;
  const closed = once(pending, 'close');
  client.resetAndDestroy();
  await closed; assert.equal(pending.destroyed, true);
});

test('large final destination response is flushed before normal closure', { timeout: 10000 }, async t => {
  const payload = Buffer.alloc(4 * 1024 * 1024, 91);
  const f = await fixture(t, socket => socket.end(payload));
  const { socket } = await tunnel(f.port, `127.0.0.1:${f.destinationPort}`);
  const received = receive(socket, payload.length);
  const closed = once(socket, 'close');
  assert.deepEqual(await received, payload);
  await closed;
});
