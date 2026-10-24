import {EventEmitter} from 'node:events';
import {deviceConfig,ota} from '../linx-config.mjs';
import {connectLinx} from '../linx.mjs';
import {createGame,advance,addSpeech,evaluate} from '../game.mjs';
const config=await deviceConfig(),credentials=(await ota(config)).websocket;
if(!credentials?.token)throw new Error('请先绑定设备');
const game=createGame();let audioBytes=0;
const answers=['老地方是哪里呀？麻烦发个定位和时间，我刚进群不知道。','大家周五晚上七点半去小馆吃火锅，小周不吃香菜，麻烦注意一下。','可能是工作进度，也可能是安排任务，但现在不知道，先问同事老板原话，再去确认。','改到周六晚上八点，还是小馆吃火锅；小周不吃香菜，大家记得。','先联系骑手确认能否放在楼下安全位置，再告诉室友我五分钟后下楼接他。带上钥匙关好门，下楼接室友时一起取外卖。','周六晚上八点在小馆吃火锅，小周不吃香菜。'];
if(process.argv.includes('--report-only'))for(let i=0;i<6;i++){addSpeech(game,answers[i]);evaluate(game,i,{question:i+1,revision:game.pending.revision,quote:answers[i].slice(0,5),feedback:'合成输入准备'});advance(game,game.pending.revision);}
for(let stage=game.stage;stage<=6;stage++){
 await new Promise((resolve,reject)=>{
  const client=new EventEmitter();client.readyState=1;let settled=false,bridge;
  const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);bridge?.close();error?reject(error):resolve();};
  const timer=setTimeout(()=>finish(new Error(`第${stage+1}阶段超时`)),80000);
  client.close=()=>{client.readyState=3;client.emit('close');};
  client.send=(raw,options)=>{
   if(options?.binary){audioBytes+=raw.length;return;}
   const message=JSON.parse(raw);
   if(message.type==='hello')client.emit('message',Buffer.from(JSON.stringify(stage===6?{type:'opening'}:{type:'text',text:answers[stage]})),false);
   if(message.type==='tts' && message.state==='sentence_start')console.log('测试员:',message.text);
   if(message.type==='hello')console.log('连接成功');
   if(message.type==='error')console.log('平台提示:',message.message);
   if(message.type==='game'&&(game.feedback||game.status==='done'))setTimeout(()=>finish(),4000);
  };
  bridge=connectLinx({config,credentials,game,client});
 });
 if(stage<6){console.log(`Q${stage+1}: ${game.feedback.text}`);advance(game,game.pending.revision);}
}
console.log(JSON.stringify({audioBytes,report:game.report},null,2));
if(!audioBytes||game.status!=='done')throw new Error('真实链路未完成');
