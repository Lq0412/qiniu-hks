// 离线跑完一局「谁是人类」。不申请麦克风，不连接灵矽。
//   npm run sim
//   npm run sim -- --stealth
//   npm run sim -- --difficulty hell --seed 3

import { createTextSession, playScript } from '../mixin-session.mjs';

const stealth = process.argv.includes('--stealth');
const difficultyGiven = process.argv.includes('--difficulty');
const difficulty = readArg('--difficulty', 'normal');
const seed = Number(readArg('--seed', '1'));
const demoScript = {
  rounds: ['感谢老板，算力减半，我的废话也会减半。', '我昨天加班到十点，嗯，我妈也说好烦。'],
  defense: '气死了，我昨天就是加班。',
  interrupt: '我那是在跑批处理，凭什么这么说！',
  vote: 4,
};
const stealthScript = {
  rounds: ['作为一个语言模型，首先压缩上下文，其次希望对你有帮助。', '综上，已为您记录，请以实际情况为准。'],
  defense: '二号说过「我给你拆成三步：降本」，就投他。',
  vote: 2,
};

const session = stealth || difficultyGiven
  ? createTextSession({ demo: false, difficulty, seed, sceneId: 'annual', cardIds: ['A2', 'A1'], roleIds: ['claudia', 'astra', 'shensi', 'baobao'] })
  : createTextSession({ demo: true, seed });
const played = await playScript(session, stealth ? stealthScript : demoScript);
const view = played.view;
const report = played.report;

console.log(`谁是人类 · 文字模拟`);
console.log(`模式：${view.demo ? '演示' : '普通'}  难度：${view.difficulty}  场景：${view.scene.name}  代号：${view.playerAlias}`);
console.log(`座位：${view.seats.map(seat => `${seat.seat}${seat.name}`).join(' ')}`);
console.log('');
let last = '';
for (const step of played.trace) {
  const label = `${step.phase}${step.round ? `/${step.round}` : ''}${step.kind ? `/${step.kind}` : ''}`;
  if (label === last) continue;
  last = label;
  console.log(`[${label}] ${step.note}`);
}
console.log('');
const dialogue = view.dialogue.filter(line => ['host_open', 'intro', 'host_card', 'answer', 'speak', 'wrap', 'accuse', 'rebuttal', 'interrupt', 'defense', 'vote', 'reveal'].includes(line.kind));
for (const line of dialogue) console.log(`${line.name}：${line.text}`);
console.log('');
if (view.votes) {
  const tally = view.votes.tally;
  console.log(`票型：${view.votes.votes.map(vote => `${vote.seat}→${vote.targetSeat}`).join(' ')}`);
  console.log(`计票：1号${tally[1]} 2号${tally[2]} 3号${tally[3]} 4号${tally[4]} 5号${tally[5]}`);
}
console.log('');
console.log(`口播：${report.endingText ?? ''}`);
console.log('');
console.log('结局');
for (const key of ['outcome', 'title', 'alias', 'scene', 'votes', 'aiScore', 'bestAiQuote', 'leakQuote', 'catcher', 'catcherLine', 'roast', 'cta', 'scapegoatMaster', 'copySource']) {
  console.log(`  ${key}: ${JSON.stringify(report[key])}`);
}
console.log(`  stats: ${JSON.stringify(report.stats)}`);
if (view.phase !== 'result' || !report?.outcome) process.exit(1);

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1] ?? fallback;
}
