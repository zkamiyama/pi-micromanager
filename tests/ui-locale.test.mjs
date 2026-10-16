import test from 'node:test';
import assert from 'node:assert/strict';
import {
  languageFor,languageChoice,setLanguageChoice,displayLanguage,
  uiText,translateTemplateFragments,localizedTemplate,
} from '../dist/pi-web/ui-locale.js';

test('browser preference selects Japanese only for the primary ja locale',()=>{
  assert.equal(languageFor('auto',['ja-JP','en-US']),'ja');
  assert.equal(languageFor('auto',['JA','en-US']),'ja');
  assert.equal(languageFor('auto',['en-US','ja-JP']),'en');
  assert.equal(languageFor('auto',['fr-FR']),'en');
  assert.equal(languageFor('auto',undefined,'ja-JP'),'ja');
  assert.equal(languageFor('auto',undefined),'en');
});

test('explicit JPN/ENG preference overrides locale and auto restores browser detection',()=>{
  try{
    assert.equal(languageChoice(),'auto');
    setLanguageChoice('ja');assert.equal(languageChoice(),'ja');assert.equal(displayLanguage(),'ja');
    setLanguageChoice('en');assert.equal(languageChoice(),'en');assert.equal(displayLanguage(),'en');
    setLanguageChoice('auto');assert.equal(languageChoice(),'auto');
    assert.throws(()=>setLanguageChoice('ru'),/Unsupported/);
  }finally{setLanguageChoice('auto');}
});

test('known UI copy translates but opaque data and technical identifiers do not',()=>{
  assert.equal(uiText('Reload','ja'),'再読込');
  assert.equal(uiText('Reload','en'),'Reload');
  assert.equal(uiText('JOURNAL','ja'),'ジャーナル');
  assert.equal(uiText('GitHub PR merge permission','ja'),'GitHub PRのマージ権限');
  assert.equal(uiText('run-id-123','ja'),'run-id-123');
  assert.equal(uiText('openai/gpt-6-luna','ja'),'openai/gpt-6-luna');
  assert.equal(uiText('sha256:'+('a'.repeat(64)),'ja'),'sha256:'+('a'.repeat(64)));
});

test('template localization only rewrites literal text/labels, preserving interpolation boundaries',()=>{
  const source=['<button title="Reload">Reload</button><input placeholder="Exact model ID" value=',
    ' /><code>', '</code>'];
  const ja=translateTemplateFragments(source,'ja');
  assert.equal(ja.length,source.length);
  assert.equal(ja[0],'<button title="再読込">再読込</button><input placeholder="正確なモデルID" value=');
  assert.equal(ja[1],' /><code>');
  assert.equal(ja[2],'</code>');
  assert.deepEqual(translateTemplateFragments(source,'en'),source);
  assert.deepEqual(source,['<button title="Reload">Reload</button><input placeholder="Exact model ID" value=',
    ' /><code>','</code>'],'input template arrays cannot be mutated');
});

test('localized HTML tag preserves bound values and stable template identity per language',()=>{
  const seen=[];
  const tag=(strings,...values)=>{seen.push({strings,values});return {strings,values}};
  const html=localizedTemplate(tag);
  const strings=['<span>Reload</span><code>', '</code>'];
  Object.defineProperty(strings,'raw',{value:[...strings]});
  try{
    setLanguageChoice('ja');
    const original={id:'task-1',permission:'deny'};
    html(strings,original);
    html(strings,original);
    assert.equal(seen[0].strings[0],'<span>再読込</span><code>');
    assert.equal(seen[0].strings,seen[1].strings,'translated template identity must be cached for Lit');
    assert.equal(seen[0].values[0],original,'untrusted runtime data is never translated');
    setLanguageChoice('en');
    html(strings,original);
    assert.equal(seen[2].strings,strings,'English templates retain their original identity');
  }finally{setLanguageChoice('auto');}
});
