// API 冒烟测试：启动服务 -> 创建/导入/冻结/提交/幂等冲突/回放
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ko-api-')), 'api.db');
const port = 18321;
const child = spawn(process.execPath, ['--experimental-strip-types', 'src/api.ts', '--port', String(port)], {
  env: { ...process.env, DB_PATH: dbPath }, stdio: 'inherit',
});
const base = `http://127.0.0.1:${port}`;
const post = (p, body, method = 'POST') =>
  fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    .then(async r => ({ status: r.status, body: await r.json() }));

await new Promise(r => setTimeout(r, 1500));
try {
  const t = await post('/tournaments', { name: '冒烟' });
  console.log('create:', t.status, t.body.id);
  await post(`/tournaments/${t.body.id}/participants`, { participants: [
    { id: 'A', name: 'a' }, { id: 'B', name: 'b' }, { id: 'C', name: 'c' }] });
  await post(`/tournaments/${t.body.id}/freeze`);
  const playable = await fetch(`${base}/tournaments/${t.body.id}/playable`).then(r => r.json());
  console.log('playable:', playable.map(m => `${m.round}:${m.index}`).join(','));
  await post(`/tournaments/${t.body.id}/matches/1/1/result`, { winnerId: 'B', idempotencyKey: 'k' });
  const dup = await post(`/tournaments/${t.body.id}/matches/1/1/result`, { winnerId: 'B', idempotencyKey: 'k' });
  console.log('idempotent dup:', dup.body.duplicated === true ? 'OK' : 'FAIL');
  const conflict = await post(`/tournaments/${t.body.id}/matches/1/1/result`, { winnerId: 'C', idempotencyKey: 'k' });
  console.log('conflict:', conflict.status, conflict.body.error.code);
  const undo = await fetch(`${base}/tournaments/${t.body.id}/matches/1/1/result`, { method: 'DELETE',
    headers: { 'content-type': 'application/json' }, body: '{}' });
  console.log('undo:', undo.status);
  const replay = await fetch(`${base}/tournaments/${t.body.id}/replay`).then(r => r.json());
  console.log('replay realResults:', replay.realResults.length);
} finally {
  child.kill();
}
