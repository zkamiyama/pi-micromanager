import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';assert.equal(readFileSync('acceptance.txt','utf8'),'synthetic acceptance confirmed\n');
