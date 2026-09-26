const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const html = fs.readFileSync('index.html','utf8');
const assets = [...html.matchAll(/(?:src|href)="([^"?#]+)(?:\?[^"#]*)?"/g)].map(m=>m[1]).filter(p=>!/^https?:/.test(p));
for(const file of assets){
  if(!fs.existsSync(file))throw new Error(`Missing asset: ${file}`);
  if(file.endsWith('.js'))execFileSync(process.execPath,['--check',file]);
}
fs.mkdirSync('dist',{recursive:true});
for(const file of ['index.html',...assets])fs.copyFileSync(file,`dist/${file}`);
console.log(`Validated and built ${assets.length+1} static files.`);
