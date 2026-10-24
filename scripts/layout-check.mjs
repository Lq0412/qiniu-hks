// Layout-only fixture. No provider requests, microphone or game decisions.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createGame, view } from '../game.mjs';
const files = { '/screen': ['index.html','text/html'], '/style.css': ['style.css','text/css'], '/app.js': ['app.js','text/javascript'], '/audio.js': ['audio.js','text/javascript'], '/recorder.js': ['recorder.js','text/javascript'] };
http.createServer(async(req,res)=>{
  if(req.url==='/') {res.setHeader('Content-Type','text/html; charset=utf-8');return res.end('<title>布局检查 · 静态任务页</title><h3>390 px 窄屏布局检查 · 静态任务状态，不连接平台</h3><iframe title="390像素任务页" src="/screen" style="width:390px;height:1250px;border:1px solid #aaa"></iframe>');}
  if(req.url==='/api/game') {res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({game:view(createGame())}));}
  if(!Object.hasOwn(files,req.url)){res.writeHead(404);return res.end();}
  const [name,type]=files[req.url];res.setHeader('Content-Type',type+'; charset=utf-8');res.end(await readFile(new URL('../public/'+name,import.meta.url)));
}).listen(4174,'127.0.0.1',()=>console.log('Layout-only fixture http://127.0.0.1:4174'));
