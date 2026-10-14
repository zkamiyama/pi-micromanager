import {readFileSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
for(const id of ['a','b']){const p=new URL('./'+id+'.txt',import.meta.url);if(existsSync(p))assert.equal(readFileSync(p,'utf8'),id.toUpperCase()+'\n');}
