import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mergeInstructionTiers, storeTiers, takeTiersFor, captureInstructionContext } from './instruction-tiers.mjs'

test('attach rule replies preserve absent values and explicitly clear nulls',()=>{
 const initial={project_agent_rules:'old',owner_agent_rules:'machine',project_custom_instructions:'principles',instruction_tiers_hash:'old',repository_context:{status:'available'}}
 const next=mergeInstructionTiers(initial,{project_agent_rules:null,instruction_tiers_hash:'new'})
 assert.equal(next.project_agent_rules,null);assert.equal(next.owner_agent_rules,'machine')
 assert.deepEqual(next.repository_context,initial.repository_context)
 assert.equal(initial.project_agent_rules,'old')
 assert.equal(mergeInstructionTiers(initial,{instructions_unchanged:true}),initial)
})

test('resumes restore complete rules and queued command snapshots survive retry and later updates',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'claude-tier-snapshot-'))
 try{
  const payload={instruction_tiers_version:1,instruction_tiers_hash:'first',project_agent_rules:'rule-'.repeat(5000)+'END'}
  storeTiers('connection',payload,{dir})
  assert.match(takeTiersFor('connection','chat',{dir}).text,/END/)
  assert.equal(takeTiersFor('connection','chat',{dir}).status,'unchanged')
  assert.match(takeTiersFor('connection','chat',{dir,force:true}).text,/END/)
  const file=captureInstructionContext('connection',payload,{dir}), before=fs.readFileSync(file,'utf8')
  assert.match(before,/END/)
  assert.equal(captureInstructionContext('connection',payload,{dir}),file,'retry must still carry the complete snapshot even after it was cached')
  const cleared=captureInstructionContext('connection',{...payload,instruction_tiers_hash:'second',project_agent_rules:null},{dir})
  assert.notEqual(cleared,file);assert.match(fs.readFileSync(cleared,'utf8'),/clears the previous value/)
  assert.equal(fs.readFileSync(file,'utf8'),before)
  assert.equal(fs.statSync(file).mode&0o777,0o600)
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
