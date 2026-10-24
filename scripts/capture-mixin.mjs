import { spawn } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
// Run against a local text-only server on port 4173; before/after use the same steps.
const variant=process.argv[2] || 'after';
if (!['before', 'after'].includes(variant)) throw Error('Expected before or after');
const profile=await mkdtemp(`${tmpdir()}/mixin-chrome-`);
const chrome=spawn('/usr/bin/google-chrome',['--headless','--no-sandbox','--disable-gpu','--remote-debugging-port=9333',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
try {
await new Promise(r=>setTimeout(r,900));
const tabs=await (await fetch('http://127.0.0.1:9333/json')).json();
const ws=new WebSocket(tabs[0].webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r);
let seq=0; const pending=new Map(); ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}};
async function cdp(method,params={}){const id=++seq;const p=new Promise(r=>pending.set(id,r));ws.send(JSON.stringify({id,method,params}));const m=await p;if(m.error)throw Error(JSON.stringify(m.error));return m.result;}
async function ev(expression){const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
await cdp('Page.enable');await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
// Stop automatic pacing only; all rendered game data and user clicks use the real app and HTTP API.
await cdp('Page.addScriptToEvaluateOnNewDocument',{source:'window.setTimeout = () => 0;'});
async function nav(){await cdp('Page.navigate',{url:'http://127.0.0.1:4173/mixin/'});await new Promise(r=>setTimeout(r,350));}
async function snap(){await ev('document.fonts.ready');const r=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(`docs/screenshots/vote-${variant}.png`,Buffer.from(r.data,'base64'));}
await nav();
let data=await ev(`fetch('/api/mixin',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sceneId:'annual',difficulty:'normal',seed:42,demo:false,roleIds:['claudia','astra','shensi','baobao']})}).then(r=>r.json())`);
const id=data.id;let clock=0;
async function act(action,body={}){data=await ev(`fetch('/api/mixin/${id}/${action}',{method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(r=>r.json())`);return data.game;}
let game=await act('start');
async function advance(){if(game.cue)game=await act('step');else if(['round_player','defense'].includes(game.phase)){game=await act('text',{text:'作为一个 AI，首先记录需求，其次整理上下文，希望对你有帮助。',typed:true});game=await act('confirm',{revision:game.pending.revision});}else {clock+=1000;game=await act('tick',{ms:1000});}}
async function show(){await ev(`sessionStorage.setItem('mixin-ui',JSON.stringify({sessionId:'${id}',clock:${clock}}))`);await nav();}
for(let i=0;i<200&&!(game.phase==='vote'&&!game.cue);i++)await advance();
await show();
// Keep the displayed buttons, then simulate an eleven-second decision before clicking.
await act('tick', {ms:11000});
const target=game.seats.find(s=>s.roleId==='shensi')||game.seats[0];
await ev(`document.querySelector('[data-vote="${target.seat}"]').click()`);await new Promise(r=>setTimeout(r,250));
const voted=await ev(`fetch('/api/mixin/${id}').then(r=>r.json())`);console.log(JSON.stringify({variant,target:target.name,playerVote:voted.game.playerVote,phase:voted.game.phase,mine:await ev("document.querySelector('#mine')?.textContent"),toast:await ev("document.querySelector('#toast')?.textContent")}));
if (variant === 'before' ? voted.game.playerVote !== null : voted.game.playerVote !== target.seat) throw Error('Unexpected vote result');
await snap();
ws.close();
} finally {
 chrome.kill();
 await new Promise(resolve => chrome.exitCode !== null ? resolve() : chrome.once('exit', resolve));
 await rm(profile, {recursive:true, force:true, maxRetries:5, retryDelay:100});
}
