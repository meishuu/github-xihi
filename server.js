const url = require('url');
const http = require('http');
const crypto = require('crypto');
const EventEmitter = require('events');

function sign(key, blob) {
  return 'sha1=' + crypto.createHmac('sha1', key).update(blob).digest('hex');
}

function eq(a, b) {
  if (a.length !== b.length) return false;

  let c = 0;
  for (let i = 0; i < a.length; i++) c |= a[i] ^ b[i];
  return c === 0;
}

function createServer(opts) {
  const emitter = new EventEmitter();

  emitter.http = http.createServer((req, res) => {
    if (url.parse(req.url).pathname !== opts.path) {
      res.statusCode = 404;
      res.end('404 Not Found');
      return;
    }

    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end('405 Method Not Allowed');
      return;
    }

    if (req.headers['content-type'] !== 'application/json') {
      res.statusCode = 415;
      res.end('415 Unsupported Media Type');
      return;
    }

    if (!req.headers['x-hub-signature'] || !req.headers['x-github-event']) {
      res.statusCode = 403;
      res.end('');
      return;
    }

    const chunks = [];
    let length = 0;

    const onData = (chunk) => {
      length = length + chunk.length;
      if (length > 10 * 1000 * 1000) {
        res.statusCode = 413;
        res.end('413 Payload Too Large');

        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        return;
      }

      chunks.push(chunk);
    };

    const onEnd = () => {
      const data = Buffer.concat(chunks, length);

      const githubSig = Buffer.from(req.headers['x-hub-signature']);
      const calcedSig = Buffer.from(sign(opts.secret, data));
      if (!eq(githubSig, calcedSig)) {
        res.statusCode = 403;
        res.end('403 Forbidden');
        return;
      }

      try {
        const payload = JSON.parse(data);
        emitter.emit(req.headers['x-github-event'], payload);
        res.statusCode = 204;
        res.end();
        return;
      } catch (err) {
        console.error(err);
        res.statusCode = 400;
        res.end('400 Bad Request');
        return;
      }
    };

    req.on('data', onData);
    req.on('end', onEnd);
  });

  return emitter;
}

module.exports = createServer;
