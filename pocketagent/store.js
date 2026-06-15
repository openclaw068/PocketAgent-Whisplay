import fs from 'node:fs';
import path from 'node:path';

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

export function loadJson(filePath, fallback) {
  try {
    const s = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

export function saveJson(filePath, data) {
  ensureDir(filePath);
  // Atomic write: write to a temp file, fsync, then rename over the target.
  // Prevents truncated/corrupt JSON if the process dies mid-write.
  const tmp = filePath + '.tmp';
  const content = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, content);
  try {
    const fd = fs.openSync(tmp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {}
  fs.renameSync(tmp, filePath);
}
