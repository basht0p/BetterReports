// Loopback-published SMTP sink for integration tests. Never forwards mail.
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { readFileSync } from 'node:fs';
const secureContext = tls.createSecureContext({ key: readFileSync('/fixtures/certs/server.key'), cert: readFileSync('/fixtures/certs/server.crt') });
const messages = [];
function attach(socket, secure = false) {
  let buffer = '', dataMode = false, lines = [];
  socket.on('error', () => {});
  const handler = chunk => {
    buffer += chunk.toString();
    let boundary;
    while ((boundary = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      if (dataMode) {
        if (line === '.') { messages.push(lines.join('\r\n')); dataMode = false; lines = []; socket.write('250 2.0.0 accepted\r\n'); }
        else lines.push(line.startsWith('..') ? line.slice(1) : line);
        continue;
      }
      if (/^EHLO|^HELO/i.test(line)) socket.write(secure ? '250-smtp\r\n250 SIZE 25000000\r\n' : '250-smtp\r\n250-STARTTLS\r\n250 SIZE 25000000\r\n');
      else if (/^STARTTLS/i.test(line)) { socket.write('220 Ready for TLS\r\n'); socket.removeListener('data', handler); const wrapped = new tls.TLSSocket(socket, { isServer: true, secureContext }); attach(wrapped, true); return; }
      else if (/^MAIL FROM|^RCPT TO|^RSET|^NOOP/i.test(line)) socket.write('250 OK\r\n');
      else if (/^DATA/i.test(line)) { dataMode = true; socket.write('354 End with dot\r\n'); }
      else if (/^QUIT/i.test(line)) socket.end('221 Bye\r\n');
      else socket.write('500 Unknown command\r\n');
    }
  };
  socket.on('data', handler);
}
net.createServer(socket => { attach(socket); socket.write('220 smtp BetterReports test sink\r\n'); }).listen(2525, '0.0.0.0');
http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ count: messages.length, messages })); }).listen(8081, '0.0.0.0');
