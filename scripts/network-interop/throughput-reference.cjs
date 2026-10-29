// Test-only Holepunch native HyperDHT/UDX reference, never bundled with Ambra.
// Same HTTP/2 payload, bearer check and 100 ms poll delay as hyperdht_server.rs.
const DHT = require('hyperdht')
const { Duplex } = require('node:stream')
const { performServerHandshake } = require('node:http2')
const dht = new DHT({ reusableSocket: true })
const sessions = new Set()
const payload = Buffer.alloc(2 * 1024 * 1024, 42)
const server = dht.createServer({ firewall: () => sessions.size >= 64 }, encrypted => {
  encrypted.on('error', () => {})
  const raw = encrypted.rawStream
  console.log(JSON.stringify({ event: 'direct', remoteHost: raw?.remoteHost, remotePort: raw?.remotePort }))
  const socket = new Duplex({
    read() { encrypted.resume() },
    // streamx.write accepts only data; Node's write callback must follow
    // its boolean backpressure/drain contract, not an ignored second argument.
    write(chunk, _encoding, done) {
      if (encrypted.write(chunk)) done()
      else encrypted.once('drain', done)
    },
    final(done) { encrypted.end(); done() },
    destroy(error, done) { encrypted.destroy(); done(error) }
  })
  encrypted.on('data', chunk => { if (!socket.push(chunk)) encrypted.pause() })
  encrypted.on('end', () => socket.push(null))
  encrypted.on('close', () => socket.destroy())
  encrypted.on('error', error => socket.destroy(error))
  socket.on('error', () => {})
  const session = performServerHandshake(socket)
  sessions.add(session)
  session.on('error', () => {})
  session.on('close', () => sessions.delete(session))
  session.on('stream', (stream, headers) => {
    stream.on('error', () => {})
    if (headers.authorization !== 'Bearer interop-fixture') {
      stream.respond({ ':status': 401 }); stream.end(); return
    }
    const path = headers[':path']
    if (path === '/api/poll') {
      const timer = setTimeout(() => {
        if (!stream.destroyed) { stream.respond({ ':status': 200 }); stream.end('update') }
      }, 100)
      stream.on('close', () => clearTimeout(timer))
    } else if (path === '/api/test' || path === '/api/stream') {
      stream.respond({ ':status': 200 })
      stream.end(path === '/api/test' ? 'ambra-server-interop' : payload)
    } else { stream.respond({ ':status': 404 }); stream.end() }
  })
})
let closing = false
async function close() {
  if (closing) return
  closing = true
  for (const session of sessions) session.destroy()
  await server.close()
  await dht.destroy()
}
server.listen(DHT.keyPair()).then(() => console.log('KEY', server.publicKey.toString('hex'))).catch(error => {
  console.error(error.message); process.exitCode = 1; void close()
})
const lifetime = setTimeout(() => { void close() }, 300000)
process.on('SIGINT', () => { clearTimeout(lifetime); void close() })
process.on('SIGTERM', () => { clearTimeout(lifetime); void close() })
