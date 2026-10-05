// 演示：5 名参赛者 -> 8 签位，首轮 3 个轮空；按不同顺序提交比赛，产生唯一冠军。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.ts';
import { TournamentService } from './service.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ko-demo-'));
const svc = new TournamentService(openDb(path.join(tmp, 'demo.db')));

const t = svc.createTournament('演示杯');
svc.importParticipants(t.id, [
  { id: 'A1', name: '头号种子' },
  { id: 'B2', name: '二号种子' },
  { id: 'C3', name: '三号种子' },
  { id: 'D4', name: '四号种子' },
  { id: 'E5', name: '五号种子' },
]);
svc.freeze(t.id);

const show = (label: string) => {
  const b = svc.getBracket(t.id);
  console.log(`\n== ${label} ==`);
  for (let r = 1; r <= b.rounds; r++) {
    const line = b.matches.filter(m => m.round === r).map(m => {
      const s = (x: typeof m.left) => x.kind === 'participant' ? x.participantId : x.kind === 'empty' ? '空' : '?';
      return `${r}:${m.index}[${s(m.left)} vs ${s(m.right)}]->${m.winnerId ?? m.status}${m.resultKind ? '/' + m.resultKind : ''}`;
    }).join('  ');
    console.log(`第${r}轮: ${line}`);
  }
  console.log(`可比赛: ${svc.playable(t.id).map(m => `${m.round}:${m.index}`).join(', ') || '(无)'}`);
};

show('冻结后（首轮 3 个轮空自动晋级；1:1 为首轮真实比赛，2:1 由两位轮空胜者会合）');
svc.submitResult(t.id, 1, 1, 'D4', { idempotencyKey: 'm11' });
show('提交 1:1 D4 胜（此前 2:0 因来源未决一直待定，不会误判轮空）');
svc.submitResult(t.id, 2, 1, 'B2', { idempotencyKey: 'm21' });
show('提交 2:1 B2 胜');
svc.submitResult(t.id, 2, 0, 'A1', { idempotencyKey: 'm20' });
show('提交 2:0 A1 胜');
svc.submitResult(t.id, 3, 0, 'A1', { idempotencyKey: 'm30' });
show('提交决赛 3:0 A1 胜');
console.log(`\n冠军: ${svc.getBracket(t.id).championId}`);
console.log(`真实比赛数: ${svc.replay(t.id).realResults.length}（应为 n-1 = 4）`);
console.log(`演示数据库: ${tmp}`);
