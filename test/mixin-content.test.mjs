import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCUSE_PROMPT, allCards, cardById, drawCards, replyFor, sceneById, SCENES } from '../mixin-bank.mjs';
import { ACCUSATION_TEMPLATES, accusationLine, agentPrompt, fillAccusation, HELLO_BRIEF, openingLine, renderBrief, reportInstruction, stageDirection, toneFor } from '../mixin-prompts.mjs';
import { HOST, PLAYER_ALIASES, ROLES, createRng, defaultLineup, pickAlias, pickLineup, relationshipLines, roleById, voiceOf } from '../mixin-roles.mjs';
import { VOICE_CATALOG } from '../mixin-voice.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'probe-results', 'playwright-report', 'test-results', 'presynth']);
const SKIP_FILES = new Set(['.linx-device.json']);

function walkRepoFiles(dir = ROOT) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkRepoFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function repoFiles(run = execFileSync) {
  try {
    const listed = run('git', ['ls-files', '-z'], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return listed.split('\0').filter(Boolean).map(file => join(ROOT, file));
  } catch {
    return walkRepoFiles();
  }
}

function assertNoRetiredVoice(files) {
  const retiredVoice = '9d91653b2adf4aa9' + 'ad97e1c8f63fbda3';
  for (const file of files) {
    assert.equal(readFileSync(file, 'utf8').includes(retiredVoice), false, file);
  }
}

test('roles are fictional, keep a voice slot, and can be dealt', () => {
  assert.equal(ROLES.length, 5);
  assert.equal(HOST.voice.voiceId, '4bdb867c07d54e119950b5bda44673a7');
  assert.equal(HOST.voice.fallbackVoiceId, null);
  assert.equal(HOST.voice.label, '典型播音女');
  assert.match(HOST.voice.description, /播音腔/);
  assert.equal(HOST.voice.rate, 'medium');
  assert.equal(HOST.voice.verified, false);
  const described = {
    claudia: /知性温柔/,
    astra: /沉稳有质感/,
    shensi: /低沉慢速/,
    baobao: /活泼/,
    xiaosi: /童声/,
  };
  const expected = {
    claudia: ['8fca6d5172fc4c309c2d16352ca8a9b3', 'b30165086267413f96643a803aed599f'],
    astra: ['2e7965636b0d4472ae51e75f419dff41', null],
    shensi: ['b38d4a6eb8f64c209fa6febfd7f91663', null],
    baobao: ['1965294143278125057', '2077603629237219330'],
    xiaosi: ['91ccc0758b22473693dfa86c8e7e3fa3', null],
  };
  for (const role of ROLES) {
    assert.equal(typeof role.voice.voiceId, 'string');
    assert.equal(role.voice.voiceId, expected[role.id][0]);
    assert.equal(role.voice.fallbackVoiceId, expected[role.id][1]);
    assert.equal(role.voice.voiceId, VOICE_CATALOG[role.id].voiceId);
    assert.match(role.voice.description, described[role.id]);
    assert.equal(typeof role.voice.rate, 'string');
    assert.equal(role.voice.verified, false);
    assert.equal(role.intro.length <= 40, true, role.intro);
    assert.ok(role.catchphrases.length >= 1);
  }
  assert.deepEqual(defaultLineup().map(seat => seat.roleId), ['claudia', 'astra', 'shensi', 'baobao']);
  const first = pickLineup(createRng(1));
  assert.equal(first.length, 4);
  assert.deepEqual(first, pickLineup(createRng(1)));
  assert.equal(new Set(first.map(seat => seat.seat)).size, 4);
  assert.ok(PLAYER_ALIASES.includes(pickAlias(createRng(2))));
  assert.equal(roleById('host').name, '群主·零号');
  assert.equal(roleById('player').id, 'player');
  assert.throws(() => roleById('claude'), /未知角色/);
  const ids = defaultLineup().map(seat => seat.roleId);
  assert.ok(relationshipLines(ids).length >= 3);
  assert.ok(relationshipLines(['xiaosi', 'baobao', 'astra', 'shensi']).some(line => line.includes('小四')));
  assert.deepEqual(relationshipLines(['astra', 'baobao']), []);
});

test('the bank has three scenes of six bounded cards', () => {
  assert.equal(SCENES.length, 3);
  assert.equal(allCards().length, 18);
  assert.equal(ACCUSE_PROMPT.includes('原话'), true);
  for (const card of allCards()) {
    for (const role of ROLES) {
      const line = replyFor(card, role.id);
      assert.equal(line.length <= 40, true, `${card.id} ${role.id} ${line}`);
    }
    for (const keyword of card.keywords) assert.equal(keyword.length >= 2, true, keyword);
  }
  assert.equal(cardById('A2').prompt.includes('算力减半'), true);
  assert.throws(() => cardById('Z9'), /未知话题卡/);
  assert.equal(sceneById('night').cards.length, 6);
  assert.throws(() => sceneById('none'), /未知场景/);
  const drawn = drawCards(sceneById('annual'), createRng(4));
  assert.equal(drawn.length, 2);
  assert.deepEqual(drawn, drawCards(sceneById('annual'), createRng(4)));
  assert.throws(() => replyFor({ id: 'X', replies: {} }, 'claudia'), /缺少/);
});

test('prompts keep the brief slot and can render every stage direction', () => {
  assert.match(agentPrompt, /\{\{counter_brief\}\}/);
  assert.doesNotMatch(agentPrompt, /\{\{game_brief\}\}/);
  assert.match(agentPrompt, /绝不向5号或玩家提问/);
  assert.match(agentPrompt, /【台词】/);
  assert.match(agentPrompt, /不调用任何工具/);
  assert.match(HELLO_BRIEF, /不要猜测谁是人类/);
  const brief = renderBrief({
    sceneName: '模型年会',
    background: '年底述职。',
    seats: defaultLineup(),
    alias: '碳基-7B',
    relationships: [],
    cards: ['算力减半', '最离谱的问题'],
    phase: 'round_ai',
    round: 1,
    spoken: [],
    situation: '身份和票型由系统固定，揭晓前不要猜测谁是人类。',
  });
  assert.match(brief, /【场景】模型年会/);
  assert.match(brief, /还没有/);
  assert.match(brief, /无/);
  assert.match(brief, /不要猜测谁是人类/);
  const spoken = renderBrief({
    sceneName: '模型年会', background: '年底述职。', seats: defaultLineup(), alias: '碳基-7B',
    relationships: ['包包嫌柯老师啰嗦'], cards: ['甲', '乙'], phase: 'reveal', round: 2,
    spoken: [{ seat: 1, text: '原话' }], situation: '结果已定',
  });
  assert.match(spoken, /1号-原话/);
  assert.match(openingLine('模型年会', '碳基-7B'), /碳基-7B/);
  const cue = { seat: 1, name: '柯老师', personality: '谨慎', sceneName: '模型年会', round: 1, card: '题', nextName: '阿斯哥', spoken: '还没有', target: 5, targetName: '碳基-7B', quote: '原话', tone: '调侃', interrupt: '打断', outcome: '潜伏成功', received: 1, alias: '碳基-7B', line: '固定台词' };
  for (const kind of ['intro', 'answer', 'rebuttal']) {
    const text = stageDirection({ ...cue, kind });
    assert.match(text, /^角色：柯老师（谨慎）。话题：/);
    assert.match(text, /一句话，20字以内。$/);
    assert.match(text, /（局势：/);
    assert.doesNotMatch(text, /【台词】/);
  }
  for (const kind of ['host_open', 'host_card', 'wrap', 'nudge', 'accuse', 'vote', 'reveal']) {
    const text = stageDirection({ ...cue, kind, seat: 0, name: kind === 'reveal' ? '' : '群主·零号' });
    assert.match(text, /^角色：群主·零号。【台词】固定台词（局势：/);
    assert.doesNotMatch(text, /口头禅|舞台指令/);
  }
  assert.throws(() => stageDirection({ kind: 'host_open', name: '群主·零号' }), /缺少台词/);
  assert.throws(() => stageDirection({ kind: 'nope' }), /未知舞台指令/);
  const quote = '我昨天加班到十点';
  for (const [roleId, templates] of Object.entries(ACCUSATION_TEMPLATES)) {
    assert.ok(templates.length >= 3, roleId);
    templates.forEach((template, index) => {
      const line = fillAccusation(template, '碳基-7B', quote);
      assert.equal(line.includes(`「${quote}」`), true, `${roleId}#${index}`);
      assert.equal(line.split(quote).length, 2, `${roleId}#${index}`);
    });
    const picked = accusationLine({ roleId, targetName: '碳基-7B', quote, random: () => 0 });
    assert.equal(picked.includes(`「${quote}」`), true);
  }
  assert.throws(() => fillAccusation('没有插槽', '五号', quote), /插槽/);
  assert.throws(() => accusationLine({ roleId: 'host', targetName: '五号', quote }), /缺少指控模板/);
  assert.equal(accusationLine({ roleId: 'claudia', targetName: '五号', quote, random: () => Number.NaN }).includes(quote), true);
  assert.equal(toneFor('hell'), '笃定');
  assert.equal(toneFor('missing'), '认真');
  assert.match(reportInstruction({ outcome: '潜伏成功', votes: '1/4', catcher: '包包', aiScore: 80, playerLines: ['原话'], titles: ['人形 Transformer'] }), /不得更改/);
  for (const file of ['mixin-session.mjs', 'mixin-http.mjs', 'mixin-game.mjs', 'humanity.mjs', 'mixin-roles.mjs', 'mixin-prompts.mjs', 'mixin-voice.mjs', 'mixin-endings.mjs', 'scripts/sim-mixin.mjs']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /getUserMedia|from '\.\/linx\.mjs'|new WebSocket/);
    assert.doesNotMatch(source, /阿柿|阿梨|阿枣|阿桃/);
  }
  const architecture = readFileSync(new URL('../docs/architecture.md', import.meta.url), 'utf8');
  assert.doesNotMatch(architecture, /阿柿|阿梨|阿枣|阿桃/);
  assert.match(architecture, /8fca6d5172fc4c309c2d16352ca8a9b3/);
  assert.match(architecture, /b38d4a6eb8f64c209fa6febfd7f91663/);
  assert.match(architecture, /深夜播客/);
  assert.match(architecture, /1965294143278125057/);
  assert.match(architecture, /4bdb867c07d54e119950b5bda44673a7/);
  assert.match(architecture, /MIXIN_VOICE_IDS/);
  assert.match(architecture, /LINX_VOICE_IDS/);
  assert.match(architecture, /顺序见探针脚本/);
  assert.match(architecture, /角色id=音色id/);
  assert.match(architecture, /3\.0–3\.5/);
  assert.match(architecture, /\{\{counter_brief\}\}/);
  assertNoRetiredVoice(repoFiles());
  assert.equal(Number(VOICE_CATALOG.baobao.voiceId).toString() === VOICE_CATALOG.baobao.voiceId, false);
  assert.equal(Number(VOICE_CATALOG.baobao.fallbackVoiceId).toString() === VOICE_CATALOG.baobao.fallbackVoiceId, false);
  const previous = process.env.MIXIN_VOICE_IDS;
  delete process.env.MIXIN_VOICE_IDS;
  try {
    assert.equal(voiceOf(roleById('shensi')).voiceId, 'b38d4a6eb8f64c209fa6febfd7f91663');
    assert.equal(voiceOf(roleById('shensi')).label, '深夜播客');
    assert.equal(voiceOf(roleById('shensi')).fallbackVoiceId, null);
    assert.equal(voiceOf(HOST).voiceId, '4bdb867c07d54e119950b5bda44673a7');
    process.env.MIXIN_VOICE_IDS = 'claudia=override-id, baobao=1965294143278125057';
    assert.equal(voiceOf(roleById('claudia')).voiceId, 'override-id');
    assert.equal(typeof voiceOf(roleById('baobao')).voiceId, 'string');
    assert.equal(voiceOf(roleById('baobao')).voiceId, '1965294143278125057');
    assert.equal(voiceOf(roleById('astra')).voiceId, '2e7965636b0d4472ae51e75f419dff41');
    process.env.MIXIN_VOICE_IDS = 'not-a-map';
    assert.equal(voiceOf(roleById('claudia')).voiceId, '8fca6d5172fc4c309c2d16352ca8a9b3');
    process.env.MIXIN_VOICE_IDS = 'claudia=';
    assert.equal(voiceOf(roleById('claudia')).voiceId, '8fca6d5172fc4c309c2d16352ca8a9b3');
  } finally {
    if (previous == null) delete process.env.MIXIN_VOICE_IDS;
    else process.env.MIXIN_VOICE_IDS = previous;
  }
});

test('retired voice scan walks files when git is unavailable', () => {
  const files = repoFiles(() => {
    const error = new Error('git missing');
    error.code = 'ENOENT';
    throw error;
  });
  assert.ok(files.length > 10);
  assert.ok(files.some(file => file.endsWith('/test/mixin-content.test.mjs')));
  assert.ok(files.every(file => !file.split('/').includes('node_modules')));
  assert.ok(files.every(file => !file.split('/').includes('.git')));
  assert.ok(files.every(file => !file.split('/').includes('presynth')));
  assert.ok(files.every(file => !file.endsWith('.linx-device.json')));
  assertNoRetiredVoice(files);
});

test('voice scan walk skips device secrets and presynth audio', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixin-scan-'));
  try {
    mkdirSync(join(dir, 'presynth'));
    writeFileSync(join(dir, 'presynth', 'host.wav'), 'RIFF');
    writeFileSync(join(dir, '.linx-device.json'), '{"token":"secret"}');
    writeFileSync(join(dir, 'humanity.mjs'), 'keep');
    assert.deepEqual(walkRepoFiles(dir), [join(dir, 'humanity.mjs')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
