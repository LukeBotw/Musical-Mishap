'use strict';
// Minimal RFC6455 WebSocket server. No dependencies.
// Supports text frames, fragmentation, ping/pong, close. Server frames are never masked.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1 << 20; // 1 MB ceiling per message

class Socket extends EventEmitter {
  constructor(raw) {
    super();
    this.raw = raw;
    this.open = true;
    this.buf = Buffer.alloc(0);
    this.fragOp = 0;
    this.fragParts = [];
    this.fragLen = 0;

    raw.on('data', (chunk) => this._feed(chunk));
    raw.on('close', () => this._down());
    raw.on('error', () => this._down());
    raw.setTimeout(0);
    raw.setNoDelay(true);
  }

  _down() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }

  _feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    // Parse as many complete frames as the buffer holds.
    for (;;) {
      const frame = this._readFrame();
      if (!frame) break;
      this._handleFrame(frame);
      if (!this.open) break;
    }
  }

  _readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;

    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const big = b.readBigUInt64BE(off);
      if (big > BigInt(MAX_MESSAGE)) { this.close(1009, 'too big'); return null; }
      len = Number(big);
      off += 8;
    }

    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4);
      off += 4;
    }
    if (b.length < off + len) return null;

    let payload = Buffer.from(b.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

    this.buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  _handleFrame(f) {
    switch (f.opcode) {
      case 0x9: // ping
        this._send(0xa, f.payload);
        return;
      case 0xa: // pong
        return;
      case 0x8: // close
        this.close(1000, '');
        return;
      case 0x0: // continuation
        if (!this.fragOp) return this.close(1002, 'bad continuation');
        this.fragParts.push(f.payload);
        this.fragLen += f.payload.length;
        if (this.fragLen > MAX_MESSAGE) return this.close(1009, 'too big');
        if (f.fin) {
          const full = Buffer.concat(this.fragParts, this.fragLen);
          const op = this.fragOp;
          this.fragOp = 0; this.fragParts = []; this.fragLen = 0;
          if (op === 0x1) this.emit('message', full.toString('utf8'));
        }
        return;
      case 0x1: // text
      case 0x2: // binary
        if (f.fin) {
          if (f.opcode === 0x1) this.emit('message', f.payload.toString('utf8'));
        } else {
          this.fragOp = f.opcode;
          this.fragParts = [f.payload];
          this.fragLen = f.payload.length;
        }
        return;
      default:
        this.close(1002, 'bad opcode');
    }
  }

  _send(opcode, payload) {
    if (!this.open) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.raw.write(Buffer.concat([header, payload]));
    } catch {
      this._down();
    }
  }

  send(str) {
    this._send(0x1, Buffer.from(str, 'utf8'));
  }

  ping() {
    this._send(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this._send(0x8, body);
    this.open = false;
    try { this.raw.end(); } catch {}
    this.emit('close');
  }
}

// Attach to a node http server. onConnect(socket, req) fires per client.
function attach(httpServer, onConnect) {
  httpServer.on('upgrade', (req, raw) => {
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
      raw.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    raw.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    onConnect(new Socket(raw), req);
  });
}

module.exports = { attach, Socket };
