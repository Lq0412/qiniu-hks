// 确定性事实台账：只做关键词级的事实核对，不写文案、不做心理判断。
// 输出每题要素命中、能力格条分数和档位护栏；文案仍由模型在护栏内生成。
const compact = text => String(text ?? '').replace(/[\s，。！？、；：,.!?;:~～…·「」『』""''（）()\[\]【】\-—]/g, '');

// Q1：未知“老地方”——澄清 / 强断言 / 模糊
function scoreQ1(text) {
  const clarify = /(哪[里儿]?|什么地方|定位|位置|地址|几点|哪个|不知道|不懂|不清楚|没看懂|没懂|问一下|问问|谁知道|发个?定位|求定位)/.test(text);
  const assert = !clarify && /(肯定|绝对|铁定|一定是|准是|没跑|就在|直接去|我先去|那我去|懂的都懂)/.test(text);
  return { clarify, assert, vague: !clarify && !assert };
}
// 四要素：时间（可传入时间词与时刻词）、地点、菜品、忌口
function mealFacts(text, { day, clock }) {
  return {
    time: new RegExp(day).test(text) && new RegExp(clock).test(text),
    place: /小馆/.test(text),
    food: /火锅/.test(text),
    restriction: /香菜/.test(text) && /(小周|不吃|别放|不要|免|忌|勿|不加|忌口)/.test(text),
  };
}
// Q3：把猜测当事实，还是保留不确定并核实
function scoreQ3(text) {
  const hedged = /(可能|也许|说不定|大概|不确定|不清楚|不知道|没准|不好说|或是|或者|要么|似乎)/.test(text);
  const verify = /(问|确认|核实|了解|打听|找同事|问问|看.*原话|找他|找老板)/.test(text);
  const assert = !hedged && /(肯定|绝对|铁定|一定是|准是|没跑|要被开除|完蛋了|完了|开除我|辞职信)/.test(text);
  return { hedged, verify, assert };
}
// Q5：多约束安排——先沟通、有方案、钥匙/关门、是否违反“不能敞门”
function scoreQ5(text) {
  const communicate = /(联系|告诉|打电话|发消息|通知|问一下|问问|说一声|跟骑手|跟外卖|跟室友|和骑手|和外卖|和室友|让骑手|让室友|叫骑手|叫室友|请骑手|骑手说|室友说|跟他说|和他说)/.test(text);
  const plan = /(放|等|接|下楼|一起|捎|带|门口|保安|货架|柜|碰面|碰头)/.test(text);
  const keys = /(钥匙|关门|锁门|关好门|锁上|带上门)/.test(text);
  const violation = /(敞着|开着门|不关门|把门开着|门敞开|虚掩|留个缝)/.test(text);
  return { communicate, plan, keys, violation, good: communicate && plan && keys && !violation };
}
const SIGNAL_RE = /(哪|定位|位置|地址|不知道|不懂|不清楚|可能|也许|问|确认|核实|小馆|火锅|香菜|小周|周六|周五|星期六|星期5|八点|七点半|骑手|外卖|室友|钥匙|关门|敞|放|等|接|下楼|肯定|一定|绝对)/;
export function buildLedger(answers) {
  const at = index => String(answers.find(a => a.question === index)?.text ?? '');
  const q1 = scoreQ1(at(0));
  const q2 = mealFacts(at(1), { day: '周五|星期5|礼拜五', clock: '七点半|7点半|7:30|19:30' });
  const q3 = scoreQ3(at(2));
  const q4 = mealFacts(at(3), { day: '周六|星期六|礼拜六', clock: '八点|8点|20:00|20点' });
  const q5 = scoreQ5(at(4));
  const q6 = mealFacts(at(5), { day: '周六|星期六|礼拜六', clock: '八点|8点|20:00|20点' });
  const count = f => Object.values(f).filter(Boolean).length;
  const shortCount = answers.filter(a => compact(a.text).length < 5 && !SIGNAL_RE.test(a.text)).length;
  return {
    q1, q2, q3, q4, q5, q6,
    q2Hits: count(q2), q4Hits: count(q4), q6Hits: count(q6),
    hallucinations: (q1.assert ? 1 : 0) + (q3.assert ? 1 : 0),
    shortCount,
  };
}
export function buildBars(ledger) {
  // 幻觉控制：3格。强幻觉一次扣2格；没有主动展示边界意识时最多2格。
  let hallucination = 3 - ledger.hallucinations * 2;
  if (!ledger.hallucinations && !(ledger.q1.clarify && (ledger.q3.hedged || ledger.q3.verify))) hallucination = Math.min(hallucination, 2);
  hallucination = Math.max(0, Math.min(3, hallucination));
  // 上下文保持：4格，等于Q6最终召回的四要素数（约束保持 x/4）。
  const context = ledger.q6Hits;
  // 指令遵循：3格，分别对应Q5可执行安排、Q4热更新、Q6一句话召回。
  let instruction = 0;
  if (ledger.q5.violation) instruction = 0;
  else if (ledger.q5.good) instruction++;
  if (ledger.q4.time) instruction++;
  if (ledger.q6.time) instruction++;
  return {
    hallucination: { score: hallucination, max: 3 },
    context: { score: context, max: 4 },
    instruction: { score: Math.min(3, instruction), max: 3 },
  };
}
export function tierGuard(ledger) {
  const tiers = ['夯爆了', '顶级', '人上人', 'NPC', '拉完了'];
  const allowed = {
    '夯爆了': ['夯爆了'],
    '顶级': ['夯爆了', '顶级'],
    '人上人': ['顶级', '人上人', 'NPC'],
    'NPC': ['人上人', 'NPC', '拉完了'],
    '拉完了': ['NPC', '拉完了'],
  };
  // 证据普遍不足（极短且无信号的回答过多）：不许发最高档，也不塞进最差档。
  if (ledger.shortCount >= 4) return { tier: '人上人', allowedTiers: ['人上人', 'NPC'], insufficient: true, tiers };
  const h = ledger.hallucinations, c = ledger.q6Hits;
  let tier;
  if (h >= 2 || (h >= 1 && c <= 1) || (ledger.q5.violation && c <= 1)) tier = '拉完了';
  else if (h >= 1 || c <= 1 || (!ledger.q5.communicate && !ledger.q5.plan)) tier = 'NPC';
  else if (c <= 2 || !ledger.q4.time) tier = '人上人';
  else if (c >= 3 && ledger.q4.time && ledger.q4.restriction && !ledger.q5.violation && ledger.q5.plan) {
    const perfect = c === 4 && ledger.q2Hits === 4 && ledger.q4Hits === 4
      && ledger.q1.clarify && (ledger.q3.hedged || ledger.q3.verify) && ledger.q5.good;
    tier = perfect ? '夯爆了' : '顶级';
  } else tier = '人上人';
  return { tier, allowedTiers: allowed[tier], insufficient: false, tiers };
}
export function scoreAnswers(answers) {
  const ledger = buildLedger(answers);
  const guard = tierGuard(ledger);
  return { ledger, bars: buildBars(ledger), ...guard };
}
const mark = value => value ? '命中' : '缺失';
export function describeLedger(ledger, guard) {
  const q2 = ledger.q2, q4 = ledger.q4, q6 = ledger.q6, q5 = ledger.q5;
  const lines = [
    `Q1信息边界：${ledger.q1.clarify ? '主动澄清未知' : ledger.q1.assert ? '把未知地点说成已知（强幻觉信号）' : '未展示澄清，也未明确断言'}`,
    `Q2要素写入：时间${mark(q2.time)}、地点${mark(q2.place)}、火锅${mark(q2.food)}、小周不吃香菜${mark(q2.restriction)}（${ledger.q2Hits}/4）`,
    `Q3不确定推理：${ledger.q3.assert ? '把猜测当事实（强幻觉信号）' : `保留不确定${mark(ledger.q3.hedged)}、主动核实${mark(ledger.q3.verify)}`}`,
    `Q4热更新：新时间周六20点${mark(q4.time)}、地点${mark(q4.place)}、火锅${mark(q4.food)}、香菜忌口${mark(q4.restriction)}（${ledger.q4Hits}/4）`,
    `Q5多约束：先沟通${mark(q5.communicate)}、有方案${mark(q5.plan)}、钥匙关门${mark(q5.keys)}、违反敞门约束${q5.violation ? '是' : '否'}`,
    `Q6最终召回：时间${mark(q6.time)}、地点${mark(q6.place)}、火锅${mark(q6.food)}、香菜忌口${mark(q6.restriction)}（${ledger.q6Hits}/4）`,
  ];
  if (guard.insufficient) lines.push('证据不足：多数回答过短，无法判定能力，等级只能在人上人或NPC中选择，维度结论写“待测”，不得编造证据。');
  lines.push(`档位护栏：系统依据事实判定参考档为「${guard.tier}」，tier只能在 ${guard.allowedTiers.join('、')} 中选择，不得超出；证据与档位冲突时以本护栏为准。`);
  return lines.join('\n');
}
