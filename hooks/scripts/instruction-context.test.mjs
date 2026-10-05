import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writePrivateJson } from './private-state.mjs'
import { mergeInstructionTiers, storeTiers, takeTiersFor, captureInstructionContext, tiersPath } from './instruction-tiers.mjs'

test('attach rule replies preserve absent values and explicitly clear nulls',()=>{
 const initial={project_agent_rules:'old',owner_agent_rules:'machine',project_custom_instructions:'principles',instruction_tiers_hash:'old',repository_context:{status:'available'}}
 const next=mergeInstructionTiers(initial,{project_agent_rules:null,instruction_tiers_hash:'new'})
 assert.equal(next.project_agent_rules,null);assert.equal(next.owner_agent_rules,'machine')
 assert.deepEqual(next.repository_context,initial.repository_context)
 assert.equal(initial.project_agent_rules,'old')
 assert.equal(mergeInstructionTiers(initial,{instructions_unchanged:true}),initial)
})

test('a delivery receipt cannot overwrite a newer rule snapshot',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-tier-race-'))
 try {
  storeTiers('c',{instruction_tiers_hash:'old',project_agent_rules:'old rules'},{dir})
  let intercepted=false
  const result=takeTiersFor('c','reader',{dir,writeReceipt:(file,receipt)=>{
   intercepted=true
   assert.notEqual(file,tiersPath('c',dir))
   // Deterministic interleaving: the poller publishes after the reader captured
   // the old snapshot but before the reader marks that snapshot consumed.
   storeTiers('c',{instruction_tiers_hash:'new',project_agent_rules:'new rules'},{dir})
   writePrivateJson(file,receipt)
  }})
  assert.equal(intercepted,true);assert.match(fs.readFileSync(result.file,'utf8'),/old rules/)
  assert.equal(JSON.parse(fs.readFileSync(tiersPath('c',dir),'utf8')).texts.project_agent_rules,'new rules')
  const bytes=fs.readFileSync(tiersPath('c',dir),'utf8')
  assert.match(fs.readFileSync(takeTiersFor('c','reader',{dir}).file,'utf8'),/new rules/)
  assert.equal(fs.readFileSync(tiersPath('c',dir),'utf8'),bytes,'consuming context never rewrites the tier cache')
 } finally { fs.rmSync(dir,{recursive:true,force:true}) }
})

test('resumes restore complete rules and queued command snapshots survive retry and later updates',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-tier-snapshot-'))
 try{
  const payload={instruction_tiers_version:1,instruction_tiers_hash:'first',project_agent_rules:'rule-'.repeat(5000)+'END'}
  storeTiers('connection',payload,{dir})
  assert.match(fs.readFileSync(takeTiersFor('connection','chat',{dir}).file,'utf8'),/END/)
  assert.equal(takeTiersFor('connection','chat',{dir}).status,'unchanged')
  assert.match(fs.readFileSync(takeTiersFor('connection','chat',{dir,force:true}).file,'utf8'),/END/)
  const file=captureInstructionContext('connection',payload,{dir}), before=fs.readFileSync(file,'utf8')
  assert.match(before,/END/)
  assert.equal(captureInstructionContext('connection',payload,{dir}),file,'retry must still carry the complete snapshot even after it was cached')
  const cleared=captureInstructionContext('connection',{...payload,instruction_tiers_hash:'second',project_agent_rules:null},{dir})
  assert.notEqual(cleared,file);assert.match(fs.readFileSync(cleared,'utf8'),/clears the previous value/)
  assert.equal(fs.readFileSync(file,'utf8'),before)
  assert.equal(fs.statSync(file).mode&0o777,0o600)
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})

// Decision 86111641: the rules always go to the file, and the model is given the same
// short line at every size. Nothing is inline when small and a pointer when large.
test('rules of any size arrive as the same short pointer to the complete text',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-tier-pointer-'))
 try{
  const shapes=[]
  for (const [hash,rules] of [['small','Short rule'],['large','rule-'.repeat(5000)+'END']]) {
   storeTiers('c',{instruction_tiers_hash:hash,project_agent_rules:rules},{dir})
   const pointed=takeTiersFor('c',`chat-${hash}`,{dir})
   assert.equal(pointed.status,'pointer')
   assert.ok(pointed.text.includes(pointed.file));assert.ok(!pointed.text.includes(rules.slice(0,20)),'the rules are never inline')
   assert.match(fs.readFileSync(pointed.file,'utf8'),new RegExp(rules.slice(-10)),'the file holds the complete rules')
   assert.equal(fs.statSync(pointed.file).mode&0o777,0o600)
   const receipt=fs.readdirSync(dir).find(f=>f.startsWith('c.tiers-delivery-')&&JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')).delivered_key.startsWith(hash))
   assert.equal(JSON.parse(fs.readFileSync(path.join(dir,receipt),'utf8')).mode,'pointer')
   // The same conversation asking again is not pointed twice, but can restate where they are.
   const again=takeTiersFor('c',`chat-${hash}`,{dir})
   assert.equal(again.status,'unchanged');assert.equal(again.pointer,pointed.text)
   shapes.push(pointed.text.replace(pointed.file,'<file>'))
  }
  assert.equal(shapes[0],shapes[1],'the same line whatever the size')
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})

test('a receipt from an earlier delivery mode counts as no delivery',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-tier-legacy-'))
 try{
  storeTiers('c',{instruction_tiers_hash:'h',project_agent_rules:'Legacy rule'},{dir})
  for (const mode of [undefined,'inline']) {
   takeTiersFor('c',`chat-${mode}`,{dir,writeReceipt:(file,receipt)=>writePrivateJson(file,{delivered_key:receipt.delivered_key,...(mode?{mode}:{})})})
   const after=takeTiersFor('c',`chat-${mode}`,{dir})
   assert.equal(after.status,'pointer');assert.match(fs.readFileSync(after.file,'utf8'),/Legacy rule/)
  }
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
