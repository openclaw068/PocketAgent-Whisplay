import fs from 'node:fs';
import path from 'node:path';

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Load JSON with corruption recovery.
 *
 * IMPORTANT: this device is known to lose power without warning (PiSugar
 * auto-shutdown). A truncated JSON file is an expected failure mode, not an
 * edge case. Previously this function silently swallowed parse errors and
 * returned the fallback, which meant a single bad power cut wiped every
 * reminder with no log line and no user-visible signal.
 *
 * Now: try the main file, fall back to the .bak sidecar, and be loud about it.
 */
export function loadJson(filePath, fallback) {
  const bakPath = `${filePath}.bak`;

  // 1) Primary file
  try {
    const s = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(s);
  } catch (e) {
    if (e?.code === 'ENOENT') {
      // Genuinely first run — not an error worth shouting about.
      return fallback;
    }
    console.error(
      `[store] FAILED to read/parse ${filePath}: ${e?.message ?? e}. ` +
      `Attempting recovery from ${bakPath}…`
    );
  }

  // 2) Backup sidecar
  try {
    const s = fs.readFileSync(bakPath, 'utf8');
    const data = JSON.parse(s);
    console.error(`[store] RECOVERED ${filePath} from backup. Re-writing primary.`);
    try { saveJson(filePath, data); } catch {}
    return data;
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      console.error(`[store] backup ${bakPath} also unusable: ${e?.message ?? e}`);
    }
  }

  // 3) Preserve the corrupt file for post-mortem rather than silently clobbering it.
  try {
    if (fs.existsSync(filePath)) {
      const quarantine = `${filePath}.corrupt-${Date.now()}`;
      fs.renameSync(filePath, quarantine);
      console.error(`[store] Quarantined unreadable file to ${quarantine}`);
    }
  } catch {}

  console.error(`[store] DATA LOSS: falling back to defaults for ${filePath}`);
  return fallback;
}

/**
 * Atomically persist JSON.
 *
 * write temp -> fsync temp -> rename over target -> fsync directory
 *
 * rename(2) is atomic within a filesystem, so a power cut leaves either the
 * complete old file or the complete new one — never a half-written one.
 * The fsync calls matter here specifically because the failure mode is a
 * hard power cut, where data sitting in the page cache is simply lost.
 */
export function saveJson(filePath, data) {
  ensureDir(filePath);

  const dir = path.dirname(filePath);
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  const bakPath = `${filePath}.bak`;
  const body = JSON.stringify(data, null, 2);

  // Roll the previous good version into .bak before replacing it.
  try {
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, bakPath);
  } catch (e) {
    console.warn(`[store] could not refresh backup ${bakPath}: ${e?.message ?? e}`);
  }

  let fd;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);          // force payload to disk
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }

  fs.renameSync(tmpPath, filePath);  // atomic swap

  // fsync the directory so the rename itself is durable.
  let dirFd;
  try {
    dirFd = fs.openSync(dir, 'r');
    fs.fsyncSync(dirFd);
  } catch {
    // Not supported on every filesystem; the rename is still atomic.
  } finally {
    if (dirFd !== undefined) { try { fs.closeSync(dirFd); } catch {} }
  }
}
