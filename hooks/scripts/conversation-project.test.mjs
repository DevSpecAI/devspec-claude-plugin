import assert from 'node:assert/strict'
import { test, beforeEach, afterEach } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { connect, ConnectError } from './devspec-remote-connect.mjs'
import { projectStatePath, readConversationProject, saveConversationProject, conversationScopeHook, readProjectSelection, inheritConversationProject } from './conversation-project.mjs'
import { prepareDevspecToolInput } from './devspec-tool-input.mjs'
import { manageProjectDefault, prepareFreshConversation } from './devspec-project.mjs'
import { confirmReferenceOnline } from './commit-provenance.mjs'
import { handleBashPost } from './repo-link-nudge.mjs'
const A={id:'11111111-1111-4111-8111-111111111111',name:'Website',organization:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'Agency'}}
const B={id:'22222222-2222-4222-8222-222222222222',name:'Website',organization:{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',name:'Client'}}
const endpoint='https://fixture.invalid/api/mcp'
let home,cwd
beforeEach(()=>{home=fs.mkdtempSync(path.join(os.tmpdir(),'claude-project-choice-'));cwd=path.join(home,'repo');fs.mkdirSync(cwd)})
afterEach(()=>fs.rmSync(home,{recursive:true,force:true}))
function backend({ ambiguous=false }={}) {
 const calls=[]
 const deps={projectHome:home,resolveAuth:()=>({ok:true,token:'fixture',mcp_url:endpoint}),
  writeState:async()=>({session_id:null,mcp_url:endpoint,auth_ok:true,poller:{skipped:true}}),
  callTool:async request=>{
   calls.push(request)
   if(request.name==='list_projects')return{projects:[A,B]}
   if(request.name==='register_connection'){
    const args=request.arguments
    if(ambiguous&&!args.project_id&&!args.pinned_project_id){const details={code:'project_choice_required',project_selection:{version:1,status:'choice_required',reason:'ambiguous_remote',candidates:[A,B]}};throw Object.assign(new Error('choose'),{details})}
    const project=[A,B].find(p=>p.id===(args.project_id||args.pinned_project_id||A.id))
    if(!project)throw new Error('Project not found or inaccessible')
    return{connection_id:'33333333-3333-4333-8333-333333333333',project_id:project.id,created:true,folder_scope_only:args.folder_scope_only,project_selection:{version:1,status:'resolved',source:args.project_id?'explicit':'git_remote',project}}
   }
   return{success:true}
  }}
 return{calls,deps}
}
const options=()=>({cwd,localId:'claude-conversation-A',noPoller:true,env:{}})
test('bare resolving connect adds no discovery call or folder write',async()=>{
 const {calls,deps}=backend();const result=await connect(options(),deps)
 assert.equal(result.project_id,A.id);assert.deepEqual(calls.map(c=>c.name),['register_connection'])
 assert.equal(fs.existsSync(path.join(cwd,'.devspec','project.json')),false)
 assert.equal(readConversationProject(options().localId,{endpoint,home}).project.id,A.id)
})
test('session attachment carries refreshed and cleared rules into the connect result',async()=>{
 const {deps}=backend();const call=deps.callTool
 deps.callTool=async request=>request.name==='attach_connection'
  ? {project_agent_rules:null,owner_agent_rules:'updated machine',instruction_tiers_version:1,instruction_tiers_hash:'attached'}
  : {...await call(request),project_agent_rules:'old project rule',owner_agent_rules:'old machine'}
 const result=await connect({...options(),session:'44444444-4444-4444-8444-444444444444'},deps)
 assert.equal(result.registration.project_agent_rules,null)
 assert.equal(result.registration.owner_agent_rules,'updated machine')
 assert.equal(result.registration.instruction_tiers_hash,'attached')
})

test('ambiguous refusal retains org-labelled choices and blocks tool fallback without a choice',async()=>{
 const {calls,deps}=backend({ambiguous:true})
 await assert.rejects(connect(options(),deps),error=>{assert(error instanceof ConnectError);assert.deepEqual(error.projectSelection.candidates,[A,B]);return true})
 assert.deepEqual(calls.map(c=>c.name),['register_connection'])
 const hook=conversationScopeHook({session_id:options().localId,tool_name:'mcp__devspec__get_project_summary',tool_input:{}},{endpoint,home})
 assert.equal(hook.hookSpecificOutput.permissionDecision,'deny')
 assert.equal(fs.existsSync(path.join(cwd,'.devspec')),false)
 assert.equal(readProjectSelection({error:'git_remote matches multiple projects'}),null)
})
test('exact ID selects; duplicate names require a choice and unknown names never fuzzy-select',async()=>{
 const {deps,calls}=backend()
 await assert.rejects(connect({...options(),project:'Website'},deps),error=>error.projectSelection.candidates.length===2)
 assert.equal(calls.some(c=>c.name==='register_connection'),false)
 await assert.rejects(connect({...options(),project:'Web'},deps),/exact name/)
 const result=await connect({...options(),project:B.id},deps)
 assert.equal(result.project_id,B.id)
 assert.equal(fs.existsSync(path.join(cwd,'.devspec')),false)
})
test('resume and parallel same-folder conversations keep separate projects after a pin changes',async()=>{
 const {deps,calls}=backend()
 await connect({...options(),project:B.id},deps)
 fs.mkdirSync(path.join(cwd,'.devspec'));fs.writeFileSync(path.join(cwd,'.devspec','project.json'),JSON.stringify({project_id:A.id}))
 await connect(options(),deps)
 assert.equal(calls.at(-1).arguments.project_id,B.id)
 await connect({...options(),localId:'claude-conversation-B',project:A.id},deps)
 assert.equal(readConversationProject('claude-conversation-A',{endpoint,home}).project.id,B.id)
 assert.equal(readConversationProject('claude-conversation-B',{endpoint,home}).project.id,A.id)
 await assert.rejects(connect({...options(),project:A.id},deps),/fresh Claude Code conversation/)
})
test('hook scope and version compose in one updatedInput without permission approval',()=>{
 saveConversationProject('firing',endpoint,B,'explicit',{home})
 const input={session_id:'firing',cwd,tool_name:'mcp__plugin_devspec_devspec__register_connection',tool_input:{local_id:'firing',plugin_version:'invented'}}
 const output=prepareDevspecToolInput(input,{home,env:{DEVSPEC_MCP_TOKEN:'fixture',DEVSPEC_MCP_URL:endpoint}})
 assert.equal(output.hookSpecificOutput.updatedInput.project_id,B.id)
 assert.notEqual(output.hookSpecificOutput.updatedInput.plugin_version,'invented')
 assert.equal(output.hookSpecificOutput.permissionDecision,undefined)
 assert.equal(conversationScopeHook({...input,tool_input:{project_id:A.id}},{endpoint,home}).hookSpecificOutput.permissionDecision,'deny')
 assert.equal(conversationScopeHook({...input,session_id:'another'},{endpoint,home}),null)
 assert.equal(conversationScopeHook({...input,tool_name:'mcp__devspec__list_projects'},{endpoint,home}),null)
 assert.equal(conversationScopeHook({...input,tool_name:'Bash'},{endpoint,home}),null)
})
test('actual hook subprocess uses the firing session, not ambient parent identity',()=>{
 saveConversationProject('firing',endpoint,B,'explicit',{home})
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('./devspec-tool-input.mjs',import.meta.url))],{input:JSON.stringify({session_id:'firing',cwd,tool_name:'mcp__devspec__get_project_summary',tool_input:{}}),encoding:'utf8',env:{...process.env,HOME:home,USERPROFILE:home,DEVSPEC_MCP_TOKEN:'fixture',DEVSPEC_MCP_URL:endpoint,CLAUDE_SESSION_ID:'parent'}})
 assert.equal(result.status,0,result.stderr)
 assert.equal(JSON.parse(result.stdout).hookSpecificOutput.updatedInput.project_id,B.id)
})
test('corrupt or foreign-endpoint state fails closed rather than using a folder',()=>{
 saveConversationProject('local',endpoint,A,'explicit',{home})
 assert.throws(()=>readConversationProject('local',{endpoint:'https://other.invalid',home}),/another DevSpec endpoint/)
 fs.writeFileSync(projectStatePath('local',home),'broken')
 assert.equal(conversationScopeHook({session_id:'local',tool_name:'mcp__devspec__get_action_items',tool_input:{}},{endpoint,home}).hookSpecificOutput.permissionDecision,'deny')
})
test('a prepared native fresh-conversation ID beats the folder default before auto-connect',async()=>{
 const {deps,calls}=backend()
 const prepared=await prepareFreshConversation(B.id,{cwd,home,call:deps.callTool,resolveAuth:deps.resolveAuth})
 assert.equal(prepared.ok,true);assert.match(prepared.launch_command,/^claude --session-id [0-9a-f-]+$/)
 assert.equal(readConversationProject(prepared.local_id,{endpoint,home}).project.id,B.id)
 const result=await connect({...options(),localId:prepared.local_id,startup:true},deps)
 assert.equal(result.project_id,B.id)
 assert.equal(calls.find(c=>c.name==='register_connection').arguments.project_id,B.id)
 assert.equal(fs.existsSync(path.join(cwd,'.devspec')),false)
})
test('same-project clear inherits scope, but another saved conversation is never overwritten',()=>{
 saveConversationProject('old',endpoint,A,'explicit',{home})
 inheritConversationProject('old','cleared',endpoint,{home})
 assert.equal(readConversationProject('cleared',{endpoint,home}).project.id,A.id)
 saveConversationProject('other',endpoint,B,'explicit',{home})
 assert.throws(()=>inheritConversationProject('old','other',endpoint,{home}),/different project/)
 assert.equal(readConversationProject('other',{endpoint,home}).project.id,B.id)
})
test('a cross-project rebond disables the old local delivery instead of adopting its connection',()=>{
 saveConversationProject('old',endpoint,A,'explicit',{home});saveConversationProject('other',endpoint,B,'explicit',{home})
 const id='33333333-3333-4333-8333-333333333333'
 const file=path.join(home,'.devspec','remote-control','connections',id+'.json')
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({connection_id:id,enabled:true,local_id:'old',mcp_url:endpoint,agent_name:'Claude Code'}))
 const source=`import {rebondConnectionToConversation} from ${JSON.stringify(new URL('./remote-control-state.mjs',import.meta.url).href)}; console.log(JSON.stringify(rebondConnectionToConversation({connectionId:${JSON.stringify(id)},localId:'other'})))`
 const processResult=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',env:{...process.env,HOME:home,USERPROFILE:home}})
 assert.equal(processResult.status,0,processResult.stderr)
 assert.equal(JSON.parse(processResult.stdout).reason,'project_scope_mismatch')
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).enabled,false)
 assert.equal(readConversationProject('other',{endpoint,home}).project.id,B.id)
})

test('commit reference checks use the selected conversation project, not a conflicting pin',async()=>{
 saveConversationProject('local',endpoint,B,'explicit',{home})
 let argumentsSeen
 const options={cwd,localId:'local',projectHome:home,marker:{kind:'pin',project_id:A.id},env:{DEVSPEC_MCP_TOKEN:'fixture',DEVSPEC_MCP_URL:endpoint},call:async request=>{argumentsSeen=request.arguments;return{online:{status:'valid'}}}}
 assert.equal(await confirmReferenceOnline('fix [devspec:'+A.id+']',options),'valid')
 assert.equal(argumentsSeen.project_id,B.id)
 fs.writeFileSync(projectStatePath('local',home),'broken')
 assert.equal(await confirmReferenceOnline('fix',options),'indeterminate')
})
test('repository nudge never directs this conversation toward another folder-default project',async()=>{
 let calls=0
 const result=await handleBashPost({session_id:'local',cwd,tool_input:{command:'git remote add origin https://github.com/example/repo.git'}},{env:{},findProjectPin:()=>({project_id:A.id}),gitRemoteOrigin:()=> 'https://github.com/example/repo.git',resolveAuth:()=>({ok:true,token:'fixture',mcp_url:endpoint}),readProject:()=>({status:'selected',project:B}),call:async()=>{calls++;return{}}})
 assert.equal(result,null);assert.equal(calls,0)
})

test('remember/forget requires a matching preview and never changes conversation selection',()=>{
 const state=saveConversationProject('local',endpoint,B,'explicit',{home})
 const preview=manageProjectDefault('remember',{cwd,state,home})
 assert.equal(preview.confirmation_required,true);assert.equal(fs.existsSync(preview.path),false)
 const saved=manageProjectDefault('remember',{cwd,state,home,confirm:true,expected:preview.expected})
 assert.equal(saved.ok,true);assert.deepEqual(JSON.parse(fs.readFileSync(preview.path,'utf8')),{project_id:B.id})
 const forget=manageProjectDefault('forget',{cwd,state,home})
 fs.writeFileSync(preview.path,JSON.stringify({project_id:A.id}))
 assert.equal(manageProjectDefault('forget',{cwd,state,home,confirm:true,expected:forget.expected}).confirmation_required,true)
 const current=manageProjectDefault('forget',{cwd,state,home})
 assert.equal(manageProjectDefault('forget',{cwd,state,home,confirm:true,expected:current.expected}).ok,true)
 assert.equal(readConversationProject('local',{endpoint,home}).project.id,B.id)
 assert.equal(fs.existsSync(preview.path),false)
})
