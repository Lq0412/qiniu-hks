import { randomUUID } from 'node:crypto';
import { questions, models, tiers, dimensions } from './benchmark.mjs';
import { scoreAnswers } from './scoring.mjs';

const shortText = (value, max) => typeof value === 'string' && value.trim() && value.trim().length <= max && value.trim();
const specFields = ['contextWindow', 'reasoning', 'deployBest', 'deployWorst'];

export class GameError extends Error {}
export function createGame() {
  return { id:randomUUID(), stage:0, status:'playing', answers:[], pending:null, feedback:null, report:null, dialogue:[], turn:0, revision:0 };
}
export function addSpeech(game,text) {
  if(game.status!=='playing'||typeof text!=='string'||!text.trim())return false;
  game.turn++;game.revision++;game.pending={text:text.trim().slice(0,2000),revision:game.revision};game.feedback=null;
  game.dialogue.push({who:'player',text:game.pending.text,stage:game.stage});return true;
}
export function evaluate(game,stage,{question,revision,quote,feedback}) {
  if(stage!==game.stage||game.status!=='playing'||question!==stage+1||!game.pending||revision!==game.pending.revision)throw new GameError('题目或回答已更新，请先读取状态。');
  if(typeof quote!=='string'||!quote.trim()||!game.pending.text.includes(quote))throw new GameError('引用必须逐字来自本次回答，短回答可以引用全文。');
  if(typeof feedback!=='string'||!feedback.trim()||feedback.length>100)throw new GameError('反馈长度不合法。');
  game.feedback={text:feedback,revision:game.revision};return view(game);
}
export function advance(game,revision) {
  if(game.status!=='playing'||!game.pending||!game.feedback||game.feedback.revision!==game.pending.revision||revision!==game.pending.revision)throw new GameError('请先等待本次回答反馈，再确认；旧版本不能覆盖重答。');
  game.answers.push({question:game.stage,text:game.pending.text});game.stage++;game.pending=null;game.feedback=null;game.turn=0;
  if(game.stage===questions.length)game.status='reporting';
  return view(game);
}
export function saveReport(game,stage,reportJson) {
  if(stage!==questions.length||game.stage!==stage||game.status!=='reporting')throw new GameError('只有全部回答确认后才能生成报告。');
  if(typeof reportJson!=='string'||reportJson.length>12000)throw new GameError('报告格式不合法。');
  let report;try{report=JSON.parse(reportJson);}catch{throw new GameError('报告需要有效JSON。');}
  if(!report||!models.includes(report.model))throw new GameError(`model必须逐字选自：${models.join('、')}。`);
  // 档位由确定性事实台账护栏约束，模型只能在证据允许的档位内套文案。
  const score=scoreAnswers(game.answers);
  if(!tiers.includes(report.tier)||!score.allowedTiers.includes(report.tier))throw new GameError(`等级「${report.tier}」与本局证据不符，tier只能在：${score.allowedTiers.join('、')}。`);
  const variant=shortText(report.variant,12);if(!variant)throw new GameError('variant是不超过12字的型号风格副标，必填。');
  for(const field of ['headline','summary','roast','advice'])if(typeof report[field]!=='string'||!report[field].trim()||report[field].length>300)throw new GameError(`报告${field}缺失或过长。`);
  const specs={};if(!report.specs||typeof report.specs!=='object')throw new GameError('报告需要specs规格栏。');
  for(const field of specFields){const v=shortText(report.specs[field],24);if(!v)throw new GameError(`specs.${field}是不超过24字的必填短句。`);specs[field]=v;}
  if(!Array.isArray(report.dimensions)||report.dimensions.length!==3)throw new GameError('报告需要三项维度。');
  for(let i=0;i<3;i++){
    const d=report.dimensions[i],answer=game.answers.find(a=>a.question===d?.question-1);
    if(d?.name!==dimensions[i]||typeof d.verdict!=='string'||!d.verdict.trim()||d.verdict.length>40||typeof d.comment!=='string'||!d.comment.trim()||d.comment.length>200)throw new GameError('维度格式不正确。');
    if(!Number.isInteger(d.question)||!answer||typeof d.quote!=='string'||!d.quote.trim()||!answer.text.includes(d.quote))throw new GameError('报告引用不在确认回答中，请逐字摘录后重新提交；短回答可以引用全文。');
  }
  // Keep only validated presentation fields; model output is never executable UI.
  // bars and ledger come from deterministic scoring, never from model-generated numbers.
  game.report={model:report.model,tier:report.tier,variant,headline:report.headline,summary:report.summary,roast:report.roast,advice:report.advice,specs,bars:score.bars,ledger:score.ledger,dimensions:report.dimensions.map(d=>({name:d.name,verdict:d.verdict,comment:d.comment,question:d.question,quote:d.quote}))};
  game.status='done';return view(game);
}
export function view(game) {
  return structuredClone({id:game.id,stage:game.stage,status:game.status,total:questions.length,current:questions[game.stage]??null,
    answers:game.answers,pending:game.pending,feedback:game.feedback,report:game.report,revision:game.revision,dialogue:game.dialogue.slice(-60)});
}
