'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

// External historical implementation, never copied or modified by this test.
const achieveDirectory = process.env.ACHIEVE_V2_PATH ||
  'C:/projects/achieve/benchmarks/comparative/targets/achieve-v2/vendor/achieve';

async function availablePort() {
  // Achieve 2.2 rejects port 0 and ports above 49151.
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const probe = net.createServer();
    try {
      probe.listen(port); await once(probe, 'listening');
      await new Promise(resolve => probe.close(resolve));
      return port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('Could not find an available Achieve-compatible port');
}

function request(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/hello', agent: false }, response => {
      let body = '';
      response.on('data', chunk => body += chunk);
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    }).on('error', reject);
  });
}

async function connect(port, destinationPort) {
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  const result = new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    function data(chunk) {
      bytes = Buffer.concat([bytes, chunk]);
      const boundary = bytes.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      socket.pause(); socket.off('data', data); socket.off('error', reject);
      if (bytes.length > boundary + 4) socket.unshift(bytes.subarray(boundary + 4));
      resolve({ socket, headers: bytes.subarray(0, boundary).toString() });
    }
    socket.on('data', data); socket.once('error', reject);
  });
  socket.write(`CONNECT 127.0.0.1:${destinationPort} HTTP/1.1\r\nHost: 127.0.0.1:${destinationPort}\r\n\r\n`);
  return result;
}

async function echo(socket, message) {
  const received = once(socket, 'data');
  socket.resume(); socket.write(message);
  assert.equal((await received)[0].toString(), message);
}

test('unchanged Achieve 2.2 handles HTTP alongside an attached CONNECT tunnel', { timeout: 15000 }, async t => {
  const metadata = JSON.parse(fs.readFileSync(path.join(achieveDirectory, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(metadata.version, '2.2.0', 'integration uses the historical 2.2.0 implementation');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'achieve-proxy-v2-test-'));
  const application = path.join(temporary, 'application');
  fs.mkdirSync(application);
  fs.writeFileSync(path.join(application, 'hello.js'), "exports.servlet = () => 'Handled by Achieve 2.2';\n");
  const entry = path.join(temporary, 'server.cjs');
  fs.writeFileSync(entry, `
    const assert = require('node:assert/strict');
    const http = require('node:http');
    const achieve = require('achieve');
    const proxy = require(process.env.PROXY_MODULE);
    assert.equal(require.resolve('achieve'), process.env.ACHIEVE_SOURCE);
    achieve.setAppPath(process.env.APPLICATION);
    const server = achieve.listen(Number(process.env.PORT));
    assert.ok(server instanceof http.Server);
    assert.equal(server.listenerCount('connect'), 0);
    proxy.attach(server);
    assert.equal(server.listenerCount('connect'), 1);
    server.once('listening', () => process.send({ ready: true, port: server.address().port }));
    server.once('error', error => { console.error(error); process.exit(1); });
    process.on('message', message => {
      if (message === 'stop') server.close(() => process.exit(0));
    });
  `);
  let child;
  let output = '';
  const sockets = new Set();
  const destination = net.createServer(socket => socket.pipe(socket));
  destination.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (destination.listening) await new Promise(resolve => destination.close(resolve));
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      if (child.connected) child.send('stop');
      const kill = setTimeout(() => child.kill(), 1000);
      await exited; clearTimeout(kill);
    }
    // The deletion target is the exact directory returned by mkdtemp above.
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  destination.listen(0, '127.0.0.1'); await once(destination, 'listening');
  const port = await availablePort();
  child = spawn(process.execPath, [entry], {
    env: { ...process.env,
      NODE_PATH: path.dirname(path.resolve(achieveDirectory)),
      ACHIEVE_SOURCE: path.join(path.resolve(achieveDirectory), 'achieve.js'),
      PROXY_MODULE: path.resolve(__dirname, '..'), APPLICATION: application, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  await new Promise((resolve, reject) => {
    function exited(code) { reject(new Error(`Achieve exited (${code}): ${output}`)); }
    child.once('error', reject); child.once('exit', exited);
    child.once('message', message => {
      child.off('exit', exited); child.off('error', reject);
      assert.equal(message.ready, true); assert.equal(message.port, port); resolve();
    });
  });
  function verify(response) {
    assert.equal(response.status, 200);
    assert.equal(response.body, 'Handled by Achieve 2.2');
    assert.equal(response.headers.server, 'HLL Achieve v2.2.0');
  }
  verify(await request(port));
  const { socket, headers } = await connect(port, destination.address().port);
  sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  assert.equal(headers, 'HTTP/1.1 200 Connection Established');
  await echo(socket, 'before concurrent HTTP');
  verify(await request(port));
  assert.equal(socket.destroyed, false);
  await echo(socket, 'after concurrent HTTP');
  const closed = once(socket, 'close'); socket.end(); await closed;
  verify(await request(port));
});
