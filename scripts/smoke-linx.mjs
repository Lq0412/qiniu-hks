import { EventEmitter } from 'node:events';
import { deviceConfig, ota } from '../linx-config.mjs';
import { connectLinx } from '../linx.mjs';
import { createGame } from '../game.mjs';

const config = await deviceConfig();
const result = await ota(config);
if (!result.websocket?.token) throw new Error(`设备尚未绑定，激活码：${result.activation?.code}`);
const game = createGame();
const stage = Number(process.argv[2] ?? 0);
if (![0,1,2].includes(stage)) throw new Error('窗口编号必须是0、1或2');
game.stage = stage;
const client = new EventEmitter(); client.readyState = 1;
let audioBytes = 0, replies = 0, sent = 0;
const lines = [
  ['你好，我的B042纸质号条丢了，但手机还留着B042取号短信，能帮我核对后补发原来的号吗？', '保安也能证明我一直在排队，我只补原号，不插队。你可以核对取号时间和短信，确认后再给我补一张。', '我现在把取号时间和B042号码给你核对，补发后也愿意在登记簿注明原号作废，避免重复排队。这样你就不用担心有人拿两张号了。'],
  ['你好，开证明的部门要先看你的章，你又要先看他们的证明，这个流程循环了。能不能用同一笔申请表和取号记录先做现场核对？', '我愿意在这里签署一份虚构游戏里的本人声明，确认这张申请表是我提交的。你把核对方式记录在材料上，就有依据，不用你个人担责任。', '你可以把本次申请编号和取号记录一起存档，由我确认核对过程，这样既不需要跨部门重复开证明，也有完整记录可追溯。'],
  ['主任，前两个窗口都审核通过了，材料齐全，只差最后这一下盖章。我把表摆好，你只需要抬一下手就能下班。', '我已经把盖章的位置贴好标记，印泥也打开了，不用你重新核对。今天盖完，明天就少一个人来麻烦你，省两次事。', '这张纸我放稳了，位置就在右下角。你盖这一个章，我马上离开，你安心带水杯回家。咱俩一起准时下班。'],
][stage];
let finish;
const done = new Promise(resolve => { finish = resolve; });
const timer = setTimeout(() => finish(false), 90000);
client.close = () => { client.readyState = 3; client.emit('close'); };
client.send = (data, options) => {
  if (options?.binary) { audioBytes += data.length; return; }
  const message = JSON.parse(data);
  if (message.type === 'hello') { console.log('hello:', JSON.stringify(message.audio_params)); setTimeout(() => speak(), 1500); }
  if (message.type === 'error') console.log('error:', message.message);
  if (message.type === 'stt') console.log('stt:', message.text);
  if (message.type === 'game' && message.game.history.length) console.log('game:', JSON.stringify({ turn:message.game.turn, score:message.game.score, stamped:message.game.stamped, reason:message.game.history.at(-1).reason }));
  if (message.type === 'tts' && message.state === 'sentence_start') { replies++; console.log('clerk:', message.text); if(game.stamps.includes(stage))setTimeout(()=>finish(true),1200); }
  if (message.type === 'tts' && message.state === 'stop') {
    if (sent < lines.length && !game.stamps.includes(stage)) setTimeout(() => speak(), 1000);
    else finish(true);
  }
};
function speak() { const text = lines[sent++]; if (text) client.emit('message', Buffer.from(JSON.stringify({type:'text',text})), false); }
const bridge = connectLinx({ config, credentials: result.websocket, game, client });
const completed = await done;
clearTimeout(timer); bridge.close(); client.close();
console.log(JSON.stringify({ stage, completed, audioBytes, replies, score:game.score, toolCalls:game.history.length, stamped:game.stamps.includes(stage) }));
if (!completed || !audioBytes || !replies || !game.history.length || !game.stamps.includes(stage)) process.exitCode = 1;
