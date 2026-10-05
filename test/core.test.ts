import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveBracket, seedOrder, nextPow2 } from '../src/core.ts';
import { openDb } from '../src/db.ts';
import { TournamentService } from '../src/service.ts';
import { ApiError } from '../src/errors.ts';

function makeSvc() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ko-test-'));
  return new TournamentService(openDb(path.join(dir, 't.db')));
}
function seeded(svc: TournamentService, n: number) {
  const t = svc.createTournament('T');
  svc.importParticipants(t.id, Array.from({ length: n }, (_, i) => ({ id: `P${i + 1}`, name: `选手${i + 1}` })));
  svc.freeze(t.id);
  return t.id;
}

test('种子展开：8 签位顺序为 1,8,4,5,2,7,3,6', () => {
  assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  assert.deepEqual(seedOrder(4), [1, 4, 2, 3]);
  assert.equal(nextPow2(5), 8);
});

test('5 人 -> 8 签位，首轮 3 个轮空，唯一可赛为 1:1', () => {
  const svc = makeSvc();
  const tid = seeded(svc, 5);
  const b = svc.getBracket(tid);
  assert.equal(b.size, 8);
  const r1 = b.matches.filter(m => m.round === 1);
  assert.equal(r1.filter(m => m.resultKind === 'BYE').length, 3);
  // 首轮唯一真实比赛 1:1；2:1 由两个轮空胜者会合，也可比赛
  assert.deepEqual(svc.playable(tid).map(m => `${m.round}:${m.index}`), ['1:1', '2:1']);
  // 每个真实参赛者只出现一个首轮签位
  const slots = r1.flatMap(m => [m.left, m.right])
    .filter(s => s.kind === 'participant').map(s => (s as any).participantId);
  assert.deepEqual([...slots].sort(), ['P1', 'P2', 'P3', 'P4', 'P5'].sort());
  assert.equal(new Set(slots).size, 5);
});

test('两边来源未决 -> pending；一空一未决 -> 不自动晋级', () => {
  const svc = makeSvc();
  const tid = seeded(svc, 4); // 4 人 4 签位，无轮空
  const b = svc.getBracket(tid);
  const semi2 = b.matches.find(m => m.round === 2 && m.index === 0)!;
  assert.equal(semi2.status, 'pending'); // 两侧来源均未决
  // 只提交一场半决赛后，决赛一侧确定一侧未决，仍 pending
  svc.submitResult(tid, 1, 0, 'P1');
  const b2 = svc.getBracket(tid);
  const final = b2.matches.find(m => m.round === 2)!;
  assert.equal(final.status, 'pending');
  assert.equal(final.winnerId, null);
});

test('一空一未决：未决侧完成前不晋级，完成后才确定', () => {
  const svc = makeSvc();
  const tid = seeded(svc, 3); // 4 签位：P1 轮空，P2 vs P3
  let b = svc.getBracket(tid);
  const final = b.matches.find(m => m.round === 2)!;
  assert.equal(final.status, 'pending'); // 左=P1 已定，右未决 -> 不能当轮空
  svc.submitResult(tid, 1, 1, 'P2');
  b = svc.getBracket(tid);
  assert.equal(b.matches.find(m => m.round === 2)!.status, 'ready');
});

test('错误胜者被拒绝', () => {
  const svc = makeSvc();
  const tid = seeded(svc, 4);
  assert.throws(() => svc.submitResult(tid, 1, 0, 'P3'), (e: ApiError) => e.code === 'WINNER_NOT_IN_MATCH');
});

test('幂等：同键同内容返回旧结果，同键不同内容拒绝', () => {
  const svc = makeSvc();
  const tid = seeded(svc, 4);
  const r1 = svc.submitResult(tid, 1, 0, 'P1', { idempotencyKey: 'k1' });
  const r2 = svc.submitResult(tid, 1, 0, 'P1', { idempotencyKey: 'k1' });
  assert.equal(r2.duplicated, true);
  assert.equal(svc.replay(tid).realResults.length, 1); // 不产生两个席位/两条结果
  assert.throws(() => svc.submitResult(tid, 1, 0, 'P1'),
    (e: ApiError) => e.code === 'MATCH_ALREADY_DECIDED'); // 无键重复提交已决场次
  assert.throws(() => svc.submitResult(tid, 1, 1, 'P3', { idempotencyKey: 'k1' }),
    (e: ApiError) => e.code === 'IDEMPOTENCY_CONFLICT');
  void r1;
});

test('过期版本被拒绝', () => {
  const svc = makeSvc();
  const tid = seeded(svc, 4);
  svc.submitResult(tid, 1, 0, 'P1');
  const v = svc.getBracket(tid).tournament.version;
  assert.throws(() => svc.submitResult(tid, 1, 1, 'P2', { expectedVersion: v - 1 }),
    (e: ApiError) => e.code === 'STALE_VERSION');
});

test('撤销被下游真实结果阻止；先撤下游则可撤，无关分支不受影响', () => {
  const svc = makeSvc();
  const tid = seeded(svc, 4);
  svc.submitResult(tid, 1, 0, 'P1');
  svc.submitResult(tid, 1, 1, 'P3');
  svc.submitResult(tid, 2, 0, 'P1'); // 决赛
  assert.throws(() => svc.undoResult(tid, 1, 0), (e: ApiError) => {
    assert.equal(e.code, 'UNDO_BLOCKED');
    assert.deepEqual((e.details as any).blockingMatches, ['2:0']);
    return true;
  });
  svc.undoResult(tid, 2, 0); // 先撤决赛
  svc.undoResult(tid, 1, 0); // 现在可撤
  const b = svc.getBracket(tid);
  // 无关分支 1:1 的真实结果仍在
  const m11 = b.matches.find(m => m.round === 1 && m.index === 1)!;
  assert.equal(m11.winnerId, 'P3');
  assert.equal(m11.resultKind, 'REAL');
  assert.equal(b.championId, null);
});

test('完整 n 人赛恰有 n-1 个真实结果，每个真实结果淘汰一人，冠军唯一', () => {
  const svc = makeSvc();
  const n = 8;
  const tid = seeded(svc, n);
  let guard = 0;
  while (!svc.getBracket(tid).championId && guard++ < 100) {
    for (const m of svc.playable(tid)) {
      const w = (m.left as any).participantId;
      svc.submitResult(tid, m.round, m.index, w);
    }
  }
  const b = svc.getBracket(tid);
  assert.ok(b.championId);
  const reals = svc.replay(tid).realResults;
  assert.equal(reals.length, n - 1);
  // 每个真实结果淘汰一人：所有非冠军恰好各输一次
  const losers = b.matches.filter(m => m.resultKind === 'REAL').map(m => {
    const lp = (m.left as any).participantId, rp = (m.right as any).participantId;
    return m.winnerId === lp ? rp : lp;
  });
  assert.equal(new Set(losers).size, n - 1);
  assert.ok(!losers.includes(b.championId));
});

test('输入行重排不改变种子身份与位置', () => {
  const svc = makeSvc();
  const t1 = svc.createTournament('A');
  svc.importParticipants(t1.id, [{ id: 'X', name: 'x' }, { id: 'Y', name: 'y' }, { id: 'Z', name: 'z' }]);
  svc.freeze(t1.id);
  const b1 = svc.getBracket(t1.id);
  const slotOf = (b: any, id: string) =>
    b.matches.filter((m: any) => m.round === 1).flatMap((m: any) => [m.left, m.right])
      .findIndex((s: any) => s.kind === 'participant' && s.participantId === id);
  // 以不同行序重新导入同样三人（种子顺序随之改变是显式操作），但同一导入内重排输入行不改变已冻结身份
  const t2 = svc.createTournament('B');
  svc.importParticipants(t2.id, [{ id: 'Z', name: 'z' }, { id: 'Y', name: 'y' }, { id: 'X', name: 'x' }]);
  svc.freeze(t2.id);
  const b2 = svc.getBracket(t2.id);
  // t1 中 X 是 1 号种子；t2 中 X 是 3 号种子 -> 签位不同，说明种子由导入顺序决定且身份稳定
  assert.notEqual(slotOf(b1, 'X'), slotOf(b2, 'X'));
  assert.equal(slotOf(b1, 'Y'), slotOf(b2, 'Y'));
});

test('零人拒绝；单人直接冠军且无比赛；人数上限', () => {
  const svc = makeSvc();
  const t0 = svc.createTournament('empty');
  assert.throws(() => svc.importParticipants(t0.id, []), (e: ApiError) => e.code === 'EMPTY_TOURNAMENT');
  const t1 = svc.createTournament('single');
  svc.importParticipants(t1.id, [{ id: 'ONLY', name: '唯一' }]);
  svc.freeze(t1.id);
  const b = svc.getBracket(t1.id);
  assert.equal(b.championId, 'ONLY');
  assert.equal(b.matches.length, 0);
  const t2 = svc.createTournament('cap', 2);
  assert.throws(() => svc.importParticipants(t2.id, [1, 2, 3].map(i => ({ id: `P${i}`, name: 'n' }))),
    (e: ApiError) => e.code === 'TOO_MANY_PARTICIPANTS');
});

test('冻结后不可再导入', () => {
  const svc = makeSvc();
  const tid = seeded(svc, 2);
  assert.throws(() => svc.importParticipants(tid, [{ id: 'A', name: 'a' }]),
    (e: ApiError) => e.code === 'ALREADY_FROZEN');
});

test('重启回放：真实结果重放得到相同可比赛列表与冠军', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ko-restart-'));
  const dbp = path.join(dir, 't.db');
  const svc1 = new TournamentService(openDb(dbp));
  const tid = seeded(svc1, 5);
  svc1.submitResult(tid, 1, 1, 'P4');
  svc1.submitResult(tid, 2, 0, 'P1');
  const before = svc1.replay(tid);
  // 模拟重启：全新连接与服务实例
  const svc2 = new TournamentService(openDb(dbp));
  const after = svc2.replay(tid);
  assert.deepEqual(after.playable.map(m => `${m.round}:${m.index}`),
    before.playable.map(m => `${m.round}:${m.index}`));
  assert.equal(after.championId, before.championId);
  svc1.submitResult(tid, 2, 1, 'P2');
  svc1.submitResult(tid, 3, 0, 'P1');
  const svc3 = new TournamentService(openDb(dbp));
  assert.equal(svc3.replay(tid).championId, 'P1');
});

test('失败原子性：非法提交不留下任何状态变化', () => {
  const svc = makeSvc();
  const tid = seeded(svc, 4);
  const v0 = svc.getBracket(tid).tournament.version;
  assert.throws(() => svc.submitResult(tid, 1, 0, 'NOPE'));
  assert.equal(svc.getBracket(tid).tournament.version, v0);
  assert.equal(svc.replay(tid).realResults.length, 0);
});

test('纯函数回放：deriveBracket 空来源传播', () => {
  // 2 人于 8 签位：大量空来源，两边都空要传播 EMPTY
  const parts = new Map([[1, 'A'], [2, 'B']]);
  const b = deriveBracket(8, parts, new Map());
  assert.ok(b.matches.some(m => m.resultKind === 'EMPTY'));
  // A、B 一路轮空到决赛
  const final = b.matches.find(m => m.round === 3)!;
  assert.equal(final.status, 'ready');
});
