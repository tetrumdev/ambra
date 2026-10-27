// Development reference only. No music, credentials, application proxy, or data relay.
const DHT = require('hyperdht')
const dht = new DHT()
let count = 0
const server = dht.createServer({ firewall: () => count >= 4 }, stream => {
  count++
  stream.on('error', () => {})
  stream.on('data', data => {
    if (data.length > 1024) stream.destroy()
    else stream.write(data)
  })
})
async function close() { await server.close(); await dht.destroy(); process.exit(0) }
server.listen(DHT.keyPair()).then(() => console.log('KEY', server.publicKey.toString('hex')))
setTimeout(close, 90000)
process.on('SIGTERM', close)
