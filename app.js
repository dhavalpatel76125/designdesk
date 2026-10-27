'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const DATABASE_PATH = path.join(__dirname, 'VELTROX-Complete-Backup-2026-10-27.json');
const HISTORY_PATH = path.join(__dirname, 'VELTROX-Design-Desk-History.json');
const MAX_JSON_BYTES = 120 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
let writeQueue = Promise.resolve();

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function serializeWrite(action) {
  const next = writeQueue.then(action);
  writeQueue = next.catch(() => {});
  return next;
}

async function readDatabase() {
  const raw = await fs.readFile(DATABASE_PATH, 'utf8');
  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.projects)) {
    throw new Error('The project JSON must contain a projects array.');
  }
  if (!data.media || typeof data.media !== 'object' || Array.isArray(data.media)) {
    data.media = {};
  }
  return data;
}

function projectRevision(projects) {
  return crypto.createHash('sha256').update(JSON.stringify(projects)).digest('hex');
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      const error = new Error('Request body exceeds the 120 MB limit.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

async function readBinaryBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) {
      const error = new Error('Image exceeds the 5 MB limit.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function writeJsonFile(filePath, data) {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function checkOrigin(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;
  } catch {}
  sendError(res, 403, 'Requests must come from this local app.');
  return false;
}

async function handleApi(req, res, pathname) {
  if (!checkOrigin(req, res)) return;

  if (pathname === '/api/desk' || pathname === '/api/desk/') {
    if (req.method === 'GET') {
      const data = await readDatabase();
      return sendJson(res, 200, {
        revision: projectRevision(data.projects),
        payload: {
          app: data.app || 'VELTROX Design Desk',
          version: data.version || 2,
          exportedAt: data.exportedAt || new Date().toISOString(),
          projects: data.projects
        },
        user: null
      });
    }
    if (req.method === 'PUT') {
      const request = await readJsonBody(req);
      if (!request || !request.payload || !Array.isArray(request.payload.projects)) {
        return sendError(res, 400, 'The save request must contain a projects array.');
      }
      const result = await serializeWrite(async () => {
        const data = await readDatabase();
        if (request.revision !== projectRevision(data.projects)) {
          return { conflict: true };
        }
        const previous = {
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          payload: {
            app: data.app || 'VELTROX Design Desk',
            version: data.version || 2,
            exportedAt: data.exportedAt || new Date().toISOString(),
            projects: data.projects
          }
        };
        let history = [];
        try {
          history = JSON.parse(await fs.readFile(HISTORY_PATH, 'utf8'));
          if (!Array.isArray(history)) history = [];
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        history.unshift(previous);
        await writeJsonFile(HISTORY_PATH, history.slice(0, 5));

        data.app = request.payload.app || 'VELTROX Design Desk';
        data.version = request.payload.version || 2;
        data.exportedAt = request.payload.exportedAt || new Date().toISOString();
        data.projects = request.payload.projects;
        await writeJsonFile(DATABASE_PATH, data);
        return { conflict: false, revision: projectRevision(data.projects) };
      });
      if (result.conflict) {
        return sendError(res, 409, 'Records changed in another window. Refresh the workspace before saving again.');
      }
      return sendJson(res, 200, { revision: result.revision });
    }
    return sendError(res, 405, 'Method not allowed.');
  }

  if (pathname === '/api/desk/history') {
    if (req.method !== 'GET') return sendError(res, 405, 'Method not allowed.');
    try {
      const copies = JSON.parse(await fs.readFile(HISTORY_PATH, 'utf8'));
      return sendJson(res, 200, { copies: Array.isArray(copies) ? copies : [] });
    } catch (error) {
      if (error.code === 'ENOENT') return sendJson(res, 200, { copies: [] });
      throw error;
    }
  }

  const imageMatch = pathname.match(/^\/api\/desk\/images\/([A-Za-z0-9_-]{1,150})$/);
  if (imageMatch) {
    const id = imageMatch[1];
    if (req.method === 'GET') {
      const data = await readDatabase();
      const image = data.media[id];
      const match = typeof image === 'string'
        ? image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/)
        : null;
      if (!match) return sendError(res, 404, 'Image not found.');
      const bytes = Buffer.from(match[2], 'base64');
      if (bytes.length > MAX_IMAGE_BYTES) return sendError(res, 413, 'Stored image exceeds the 5 MB limit.');
      res.writeHead(200, {
        'Content-Type': match[1],
        'Content-Length': bytes.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(bytes);
    }
    if (req.method === 'PUT') {
      const type = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
      if (!IMAGE_TYPES.has(type)) return sendError(res, 415, 'Only JPG, PNG, and WebP images are supported.');
      const image = await readBinaryBody(req);
      if (!image.length) return sendError(res, 400, 'Image data is empty.');
      await serializeWrite(async () => {
        const data = await readDatabase();
        data.media[id] = `data:${type};base64,${image.toString('base64')}`;
        await writeJsonFile(DATABASE_PATH, data);
      });
      return sendJson(res, 200, { saved: true });
    }
    return sendError(res, 405, 'Method not allowed.');
  }

  return sendError(res, 404, 'Not found.');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url.pathname);
    }
    if ((req.method === 'GET' || req.method === 'HEAD') &&
        (url.pathname === '/' || url.pathname === '/index.html')) {
      let html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
      html = html.replace('<script>', '<script>window.__VELTROX_LOCAL__=true;</script><script>');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(html),
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(req.method === 'HEAD' ? undefined : html);
    }
    return sendError(res, 404, 'Not found.');
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      return sendError(res, error.statusCode || 500, error.statusCode ? error.message : 'Local server error.');
    }
    res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`VELTROX Design Desk is running at http://${HOST}:${PORT}`);
  console.log(`Project data: ${DATABASE_PATH}`);
});

server.on('error', error => {
  console.error('Could not start the local server:', error.message);
  process.exitCode = 1;
});
