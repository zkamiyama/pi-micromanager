/** Fixed read-only program executed INSIDE the existing Bubblewrap mount boundary.
 * Input is JSON data, never shell or JavaScript. No extra host mount/permission. */
export const REPOSITORY_SEARCH_SERVICE=String.raw`
const fs=require('node:fs'),p=require('node:path');
const input=fs.readFileSync(0,'utf8');if(Buffer.byteLength(input)>4096)throw Error('Search input budget');
const q=JSON.parse(input),root='/workspace';
if(!q||!['glob','search'].includes(q.op))throw Error('Unknown discovery operation');
const prefix=q.pathPrefix||'';
if(typeof prefix!=='string'||prefix.length>160||prefix.startsWith('/')||prefix.includes('\\')||
 prefix.split('/').some(s=>s&&(s.startsWith('.')||! /^[a-zA-Z0-9._-]+$/.test(s))))throw Error('Invalid search prefix');
if(prefix.endsWith('/')||prefix.includes('//'))throw Error('Invalid search prefix');
const pattern=q.glob||'**';
if(typeof pattern!=='string'||!pattern.length||pattern.length>160||pattern.startsWith('/')||
 pattern.endsWith('/')||pattern.includes('//')||pattern.split('/').some(s=>
 s.startsWith('.')||! /^[a-zA-Z0-9_.*?-]+$/.test(s)))throw Error('Invalid bounded glob');
if(q.op==='search'&&(typeof q.text!=='string'||q.text.length<2||q.text.length>120||q.text.includes('\0')))
 throw Error('Bounded literal search required');
// Dynamic-programming glob matching, not a model-controlled regular expression.
function partMatch(glob,name){
 let row=Array(name.length+1).fill(false);row[0]=true;
 for(const c of glob){const next=Array(name.length+1).fill(false);next[0]=c==='*'&&row[0];
  for(let j=1;j<=name.length;j++)next[j]=c==='*'?(row[j]||next[j-1]):row[j-1]&&(c==='?'||c===name[j-1]);
  row=next;
 }return row[name.length];
}
function match(glob,name){
 const a=glob.split('/'),b=name.split('/');let row=Array(b.length+1).fill(false);row[0]=true;
 for(const part of a){const next=Array(b.length+1).fill(false);next[0]=part==='**'&&row[0];
  for(let j=1;j<=b.length;j++)next[j]=part==='**'?(row[j]||next[j-1]):row[j-1]&&partMatch(part,b[j-1]);
  row=next;
 }return row[b.length];
}
const excluded=new Set(['node_modules','vendor','dist','build','coverage']);
const pending=[''],files=[];let entries=0,truncated=false,skipped=0;
while(pending.length&&files.length<1200&&entries<12000){
 const folder=pending.shift(),full=p.join(root,folder);let dir;
 try{if(fs.lstatSync(full).isSymbolicLink()){skipped++;continue;}dir=fs.opendirSync(full);
  const children=[];let e;
  while((e=dir.readSync())!==null){if(++entries>12000){truncated=true;break;}children.push(e);}
  children.sort((a,b)=>a.name.localeCompare(b.name));
  for(const e of children){
   if(e.name.startsWith('.')||excluded.has(e.name)||e.isSymbolicLink()){skipped++;continue;}
   const rel=folder?folder+'/'+e.name:e.name;
   if(rel.length>240||rel.split('/').length>30){truncated=true;continue;}
   const stat=fs.lstatSync(p.join(root,rel));
   if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink!==1){skipped++;continue;}
   if(stat.isDirectory()){
    // Prefix pruning lets callers explore trees larger than the global bound.
    if(!prefix||prefix===rel||prefix.startsWith(rel+'/')||rel.startsWith(prefix+'/')){
     if(pending.length<1200)pending.push(rel);else truncated=true;
    }
   }else if(stat.isFile()&&(!prefix||rel===prefix||rel.startsWith(prefix+'/'))){
    if(files.length>=1200){truncated=true;break;}
    files.push(rel);
   }
  }
 }catch{truncated=true;skipped++;}finally{if(dir)dir.closeSync();}
}
if(pending.length||entries>=12000||files.length>=1200)truncated=true;
const selected=files.sort().filter(f=>match(pattern,f));
if(q.op==='glob'){
 process.stdout.write(JSON.stringify({files:selected.slice(0,120),totalCapped:selected.length,
  scannedEntries:Math.min(entries,12000),skipped,truncated:truncated||selected.length>120}));
}else{
 const matches=[];let scannedBytes=0;
 for(const rel of selected){
  if(matches.length>=60){truncated=true;break;}
  const full=p.join(root,rel);let fd;
  try{
   // O_NOFOLLOW protects a late leaf replacement; canonical and link checks
   // protect ancestor aliases. All reads are still inside the OS mount boundary.
   if(fs.realpathSync(full)!==full){skipped++;continue;}
   const before=fs.lstatSync(full);if(!before.isFile()||before.nlink!==1||before.size>131072){skipped++;continue;}
   fd=fs.openSync(full,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
   const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.ino!==before.ino||stat.dev!==before.dev||stat.nlink!==1){skipped++;continue;}
   if(scannedBytes+stat.size>3145728){truncated=true;break;}
   // Fixed buffer avoids unbounded readFile if a writable peer grows the file.
   const bytes=Buffer.alloc(131073),n=fs.readSync(fd,bytes,0,bytes.length,0);
   scannedBytes+=n;if(n>131072||scannedBytes>3145728){truncated=true;break;}
   const data=bytes.subarray(0,n);if(data.includes(0)){skipped++;continue;}
   const lines=data.toString('utf8').split(/\r?\n/);
   for(let i=0;i<lines.length;i++)if(lines[i].includes(q.text)){
    if(matches.length>=60){truncated=true;break;}
    matches.push({path:rel,line:i+1,text:lines[i].slice(0,180)});
   }
  }catch{truncated=true;skipped++;}finally{if(fd!==undefined)fs.closeSync(fd);}
 }
 process.stdout.write(JSON.stringify({matches,scannedBytes,scannedEntries:Math.min(entries,12000),skipped,truncated}));
}
`;
