import http from 'node:http';

const DISPLAY_HOST = process.env.POCKETAGENT_DISPLAY_HOST || '127.0.0.1';
const DISPLAY_PORT = Number(process.env.POCKETAGENT_DISPLAY_PORT || 3782);

function reqOptions(pathname, method, bodyBuf = null) {
  const headers = bodyBuf
    ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bodyBuf.length }
    : {};
  return {
    method,
    hostname: DISPLAY_HOST,
    port: DISPLAY_PORT,
    path: pathname,
    headers,
    timeout: 1500
  };
}

export async function displayUpdate(patch) {
  if ((process.env.POCKETAGENT_DISPLAY_MODE || 'auto').toLowerCase() === 'off') return;

  const bodyBuf = Buffer.from(JSON.stringify(patch ?? {}));
  return await new Promise((resolve) => {
    const req = http.request(reqOptions('/update', 'POST', bodyBuf), res => {
      res.on('data', () => {});
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ status: 0 }); });
    req.on('error', () => resolve({ status: 0 }));
    req.write(bodyBuf);
    req.end();
  });
}
