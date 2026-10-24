// 把 public/mixin/assets/chars/*.webp 内嵌进 public/mixin/style.css 的标记块。
// 服务端只放行白名单静态文件（/mixin/style.css 等），CSP 允许 img-src data:，
// 所以角色贴纸以 data URI 写进样式表，不需要改服务端。改了图片后运行：
//   node scripts/embed-chars.mjs
import { readFile, writeFile, readdir } from 'node:fs/promises';

const dir = new URL('../public/mixin/assets/chars/', import.meta.url);
const cssUrl = new URL('../public/mixin/style.css', import.meta.url);
const BEGIN = '/* chars:begin（node scripts/embed-chars.mjs 生成，勿手改） */';
const END = '/* chars:end */';

const files = (await readdir(dir)).filter(name => name.endsWith('.webp')).sort();
const rules = [];
for (const name of files) {
  const data = await readFile(new URL(name, dir));
  rules.push(`.av-${name.replace(/\.webp$/, '').replace(/_/g, '-')}{background-image:url(data:image/webp;base64,${data.toString('base64')})}`);
}
const block = `${BEGIN}\n${rules.join('\n')}\n${END}`;
const css = await readFile(cssUrl, 'utf8');
const start = css.indexOf(BEGIN);
const end = css.indexOf(END);
const next = start >= 0 && end > start
  ? css.slice(0, start) + block + css.slice(end + END.length)
  : `${css.trimEnd()}\n\n${block}\n`;
await writeFile(cssUrl, next);
console.log(`嵌入 ${files.length} 张角色贴纸`);
