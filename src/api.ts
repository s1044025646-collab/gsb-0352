import http from 'node:http';
import { openDb } from './db.ts';
import { TournamentService } from './service.ts';
import { ApiError } from './errors.ts';

const svc = new TournamentService(openDb());

async function readBody(req: http.IncomingMessage): Promise<any> {
  let data = '';
  for await (const chunk of req) data += chunk;
  if (!data) return {};
  try { return JSON.parse(data); } catch { throw new ApiError(400, 'INVALID_INPUT', '请求体不是合法 JSON'); }
}

function num(v: string | undefined, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ApiError(400, 'INVALID_INPUT', `${name} 必须为整数`);
  return n;
}

const server = http.createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method ?? 'GET';
    const body = method === 'POST' || method === 'DELETE' ? await readBody(req) : {};

    if (method === 'POST' && parts[0] === 'tournaments' && parts.length === 1) {
      return send(201, svc.createTournament(body.name, body.maxParticipants));
    }
    const tid = parts[0] === 'tournaments' && parts[1] ? num(parts[1], 'tournamentId') : null;
    if (tid === null) throw new ApiError(404, 'NOT_FOUND', '未知路由');

    if (method === 'POST' && parts[2] === 'participants') {
      return send(200, svc.importParticipants(tid, body.participants));
    }
    if (method === 'POST' && parts[2] === 'freeze') return send(200, svc.freeze(tid));
    if (method === 'GET' && parts[2] === 'bracket') return send(200, svc.getBracket(tid));
    if (method === 'GET' && parts[2] === 'playable') return send(200, svc.playable(tid));
    if (method === 'GET' && parts[2] === 'replay') return send(200, svc.replay(tid));
    if (method === 'GET' && parts[2] === 'export') return send(200, svc.export(tid));
    if (method === 'GET' && parts[2] === 'participants' && parts[3] && parts[4] === 'path') {
      return send(200, svc.participantPath(tid, decodeURIComponent(parts[3])));
    }
    if (parts[2] === 'matches' && parts.length >= 5) {
      const round = num(parts[3], 'round');
      const index = num(parts[4], 'index');
      if (method === 'POST' && parts[5] === 'result') {
        return send(200, svc.submitResult(tid, round, index, body.winnerId, {
          idempotencyKey: body.idempotencyKey, expectedVersion: body.expectedVersion,
        }));
      }
      if (method === 'DELETE' && parts[5] === 'result') {
        return send(200, svc.undoResult(tid, round, index, body.expectedVersion));
      }
    }
    throw new ApiError(404, 'NOT_FOUND', '未知路由');
  } catch (e) {
    if (e instanceof ApiError) return send(e.status, { error: { code: e.code, message: e.message, details: e.details } });
    console.error(e);
    return send(500, { error: { code: 'INTERNAL', message: '服务器内部错误' } });
  }
});

// 默认 0：自动选择空闲端口；可用 --port 或 PORT 指定
const argPort = process.argv.find((a, i) => i > 1 && process.argv[i - 1] === '--port');
const port = argPort ? Number(argPort) : Number(process.env.PORT ?? 0);
server.listen(port, () => {
  const addr = server.address();
  console.log(`API 服务已启动: http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : port}`);
});
