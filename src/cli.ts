// CLI：直接操作服务层（与 API 共用同一 SQLite 数据目录）
import fs from 'node:fs';
import { openDb } from './db.ts';
import { TournamentService } from './service.ts';
import { ApiError } from './errors.ts';
import type { MatchView } from './core.ts';

const svc = new TournamentService(openDb());

function srcLabel(s: MatchView['left']): string {
  if (s.kind === 'participant') return s.participantId;
  if (s.kind === 'empty') return '(空)';
  return '(未决)';
}

function printBracket(tid: number) {
  const b = svc.getBracket(tid);
  console.log(`赛事#${tid} 大小=${b.size} 轮数=${b.rounds} 冠军=${b.championId ?? '未产生'}`);
  for (let r = 1; r <= b.rounds; r++) {
    console.log(`-- 第 ${r} 轮 --`);
    for (const m of b.matches.filter(x => x.round === r)) {
      const kind = m.resultKind ? ` [${m.resultKind}]` : '';
      console.log(`  场次 ${r}:${m.index}  ${srcLabel(m.left)} vs ${srcLabel(m.right)}  -> ${m.winnerId ?? m.status}${kind}`);
    }
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  switch (cmd) {
    case 'create': {
      const t = svc.createTournament(opt('name') ?? '未命名赛事', opt('max') ? Number(opt('max')) : undefined);
      console.log(`已创建赛事 id=${t.id}`);
      break;
    }
    case 'import': {
      // import <tid> --file seeds.json （JSON 数组 [{id,name},...]，顺序即种子顺序）
      const list = JSON.parse(fs.readFileSync(opt('file')!, 'utf8'));
      svc.importParticipants(Number(args[0]), list);
      console.log('已导入参赛者');
      break;
    }
    case 'freeze': {
      svc.freeze(Number(args[0]));
      console.log('签表已冻结');
      printBracket(Number(args[0]));
      break;
    }
    case 'bracket': printBracket(Number(args[0])); break;
    case 'playable': {
      for (const m of svc.playable(Number(args[0]))) {
        console.log(`${m.round}:${m.index}  ${srcLabel(m.left)} vs ${srcLabel(m.right)}`);
      }
      break;
    }
    case 'submit': {
      // submit <tid> <round> <index> <winnerId> [--key K] [--version V]
      const [tid, r, i, w] = args;
      const res = svc.submitResult(Number(tid), Number(r), Number(i), w, {
        idempotencyKey: opt('key'), expectedVersion: opt('version') ? Number(opt('version')) : undefined,
      });
      console.log(res.duplicated ? '幂等重复，返回旧结果' : `已记录胜者 ${w}`);
      break;
    }
    case 'undo': {
      svc.undoResult(Number(args[0]), Number(args[1]), Number(args[2]),
        opt('version') ? Number(opt('version')) : undefined);
      console.log('已撤销并重新推导');
      break;
    }
    case 'path': console.log(JSON.stringify(svc.participantPath(Number(args[0]), args[1]), null, 2)); break;
    case 'replay': console.log(JSON.stringify(svc.replay(Number(args[0])), null, 2)); break;
    case 'export': console.log(JSON.stringify(svc.export(Number(args[0])), null, 2)); break;
    default:
      console.log('命令: create | import | freeze | bracket | playable | submit | undo | path | replay | export');
  }
}

main().catch(e => {
  if (e instanceof ApiError) {
    console.error(`错误 [${e.code}] ${e.message}`);
    if (e.details) console.error(JSON.stringify(e.details));
    process.exit(2);
  }
  throw e;
});
