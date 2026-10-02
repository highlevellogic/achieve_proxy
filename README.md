# achieve_proxy

Dependency-free HTTP CONNECT tunneling for an existing Node HTTP server. Requires Node.js 22 or later.

```js
const http = require('node:http');
const proxy = require('achieve_proxy');
const server = http.createServer((req, res) => res.end('Hello'));
const detach = proxy.attach(server);
server.listen(8989);
```

For Achieve 2.2, pass the server returned by `achieve.listen(8989)` to `proxy.attach(server)`. Achieve is not a dependency.

`attach(server)` installs one CONNECT listener and returns a function that removes it. Existing CONNECT listeners and duplicate attachment are rejected. Detaching does not close active tunnels. Attach during startup before accepting requests.

Targets must be `hostname:port`, `IPv4:port`, or `[IPv6]:port`, with a port from 1 to 65535. Hostnames use ASCII DNS labels. Malformed targets receive 400; destination connection failures receive 502. A connected destination receives the initial `head` bytes and subsequent data unchanged. Ordinary HTTP requests retain their existing handler.

There is no authentication, destination policy, reverse proxying, TLS termination, or explicit timeout setting. Destination connections use operating-system connection timeouts. Active tunnels are sockets owned by this module; applications needing graceful shutdown must account for them separately. Use in environments where unrestricted TCP tunneling is intended.

Run `npm test` for local HTTP/TCP integration tests.
