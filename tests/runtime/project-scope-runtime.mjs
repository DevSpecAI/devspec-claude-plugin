/** Installed Claude Code + real plugin hooks, scripted loopback provider/MCP. No paid inference or live records. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readConversationProject } from '../../hooks/scripts/conversation-project.mjs'
const root=fileURLToPath(new URL('../..',import.meta.url)), home=mkdtempSync(join(tmpdir(),'claude-project-runtime-'))
const A={id:'11111111-1111-4111-8111-111111111111',name:'Website',organization:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'Agency'}}
const B={id:'22222222-2222-4222-8222-222222222222',name:'Website',organization:{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',name:'Client'}}
let localId=randomUUID()
const connectionId=randomUUID(), mcpCalls=[]
const questionMode=process.argv.includes('--question'), cancelMode=process.argv.includes('--cancel')
const expectedAnswer=cancelMode?'Continue without connecting':'Website — Client'
let modelCalls=0, commandLoaded=false, statusScoped=false, questionAnswered=false, questionResultObserved=false, repositoryContextObserved=false, statusResult=''
const textResult=data=>({content:[{type:'text',text:JSON.stringify(data)}]})
function modelResponse(res,body,block,stop) {
 const message={id:'msg_fixture_'+modelCalls,type:'message',role:'assistant',content:[block],model:body.model,stop_reason:stop,stop_sequence:null,usage:{input_tokens:10,output_tokens:10}}
 if(!body.stream){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(message));return}
 res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'})
 const send=(event,data)=>res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
 send('message_start',{type:'message_start',message:{...message,content:[],stop_reason:null,usage:{input_tokens:10,output_tokens:0}}})
 send('content_block_start',{type:'content_block_start',index:0,content_block:block.type==='tool_use'?{...block,input:{}}:{type:'text',text:''}})
 send('content_block_delta',{type:'content_block_delta',index:0,delta:block.type==='tool_use'?{type:'input_json_delta',partial_json:JSON.stringify(block.input)}:{type:'text_delta',text:block.text}})
 send('content_block_stop',{type:'content_block_stop',index:0})
 send('message_delta',{type:'message_delta',delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:10}})
 send('message_stop',{type:'message_stop'});res.end()
}
const server=createServer(async(req,res)=>{
 try {
  let raw='';for await(const part of req)raw+=part
  const body=raw?JSON.parse(raw):{}
  if(req.url.startsWith('/v1/messages/count_tokens')){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"input_tokens":100}');return}
  if(req.url.startsWith('/v1/messages')){
   const tool=body.tools?.find(t=>t.name?.endsWith('get_project_summary'))?.name
   if(!tool){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'aux',type:'message',role:'assistant',content:[{type:'text',text:'fixture'}],model:body.model,stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}));return}
   modelCalls++
   commandLoaded ||= JSON.stringify(body.messages).includes('Project choice belongs to the firing')
   repositoryContextObserved ||= JSON.stringify(body.messages).includes('https://example.test/project-b/repo-24.git')
   const completedTools=new Set()
   for (const message of body.messages ?? []) for (const block of Array.isArray(message.content) ? message.content : []) {
    if(block.type==='tool_result')completedTools.add(block.tool_use_id)
    if(block.type==='tool_result' && block.tool_use_id==='tool_fixture_1') { statusResult=JSON.stringify(block.content);statusScoped ||= statusResult.includes(B.id) }
    if(block.type==='tool_result' && block.tool_use_id==='tool_question') questionResultObserved ||= JSON.stringify(block.content).includes(expectedAnswer)
   }
   // Request count is not workflow progress: retries/cache warming may repeat an
   // identical request. Advance only from tool results in this request's transcript.
   if(questionMode && !completedTools.has('tool_question'))modelResponse(res,body,{type:'tool_use',id:'tool_question',name:'AskUserQuestion',input:{questions:[{question:'Which project should this conversation use?',header:'Project',options:[{label:'Website — Agency',description:A.id},{label:'Website — Client',description:B.id},{label:'Continue without connecting',description:'Cancel this choice'}],multiSelect:false}]}},'tool_use')
   else if(questionMode && cancelMode)modelResponse(res,body,{type:'text',text:'PROJECT-HOOK-RUNTIME-PASS'},'end_turn')
   else if(questionMode && !completedTools.has('tool_after_question'))modelResponse(res,body,{type:'tool_use',id:'tool_after_question',name:tool,input:{}},'tool_use')
   else if(questionMode)modelResponse(res,body,{type:'text',text:'PROJECT-HOOK-RUNTIME-PASS'},'end_turn')
   else if(!completedTools.has('tool_fixture_1'))modelResponse(res,body,{type:'tool_use',id:'tool_fixture_1',name:'Bash',input:{command:`node ${JSON.stringify(join(root,'hooks/scripts/devspec-project.mjs'))} status`,description:'Read the selected project for this test conversation'}},'tool_use')
   else if(!completedTools.has('tool_fixture_2'))modelResponse(res,body,{type:'tool_use',id:'tool_fixture_2',name:tool,input:{project_id:A.id}},'tool_use')
   else if(!completedTools.has('tool_fixture_3'))modelResponse(res,body,{type:'tool_use',id:'tool_fixture_3',name:tool,input:{}},'tool_use')
   else modelResponse(res,body,{type:'text',text:'PROJECT-HOOK-RUNTIME-PASS'},'end_turn')
   return
  }
  if(req.url.startsWith('/api/mcp')){
   if(req.method!=='POST'){res.writeHead(405);res.end();return}
   let result={}
   if(body.method==='initialize')result={protocolVersion:'2025-03-26',serverInfo:{name:'devspec-fixture',version:'1'},capabilities:{tools:{}}}
   else if(body.method==='notifications/initialized'){res.writeHead(202);res.end();return}
   else if(body.method==='tools/list')result={tools:[{name:'get_project_summary',description:'Read the current project summary.',inputSchema:{type:'object',properties:{project_id:{type:'string'}}}}]}
   else if(body.method==='tools/call'){
    const {name,arguments:args={}}=body.params;mcpCalls.push({name,args})
    if(name==='register_connection')result={...textResult({connection_id:connectionId,project_id:B.id,created:true,session_id:null,codename:'Fixture',repository_context:{version:1,project_id:B.id,status:'available',repositories:Array.from({length:25},(_,i)=>({id:`repo-${i}`,full_name:`project-b/repo-${i}`,provider:'github',git_url:`https://example.test/project-b/repo-${i}.git`,target_branch:'staging',default_branch:'main'}))},project_selection:{version:1,status:'resolved',source:'explicit',project:B}}),_meta:{devspec:{connection_capability:{version:1,value:'dvsc_fixture_only_12345678901234567890'}}}}
    else if(name==='list_projects')result=textResult({projects:[A,B]})
    else result=textResult({success:true,connection_id:connectionId,project_id:args.project_id??B.id})
   }
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));return
  }
  res.writeHead(200,{'Content-Type':'application/json'});res.end('{}')
 }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}))}
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const origin=`http://127.0.0.1:${server.address().port}`, endpoint=origin+'/api/mcp'
const env={...process.env,HOME:home,USERPROFILE:home,CLAUDE_CONFIG_DIR:join(home,'.claude'),ANTHROPIC_API_KEY:'sk-ant-fixture-only-not-a-real-key',ANTHROPIC_BASE_URL:origin,DEVSPEC_MCP_TOKEN:'fixture-only-not-a-real-token',DEVSPEC_MCP_URL:endpoint,CLAUDE_PLUGIN_OPTION_CONNECT_AT_STARTUP:'false',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',NO_PROXY:'127.0.0.1,localhost',NODE_OPTIONS:''}
for(const name of ['ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','CLAUDECODE','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','CLAUDE_CODE_SESSION_ID','CLAUDE_SESSION_ID','DEVSPEC_REMOTE_LOCAL_ID_CLAUDE_CODE'])delete env[name]
function run(command,args,timeout=90000) {
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd:home,env,stdio:['ignore','pipe','pipe']});let out='',err=''
  const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('Runtime timed out: '+err.slice(-1500)+' / '+out.slice(-1500)))},timeout)
  child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c)
  child.once('error',error=>{clearTimeout(timer);reject(error)})
  child.once('exit',code=>{clearTimeout(timer);if(code===0)resolve({out,err});else reject(new Error(`Exit ${code}: ${err.slice(-2000)} / ${out.slice(-2000)}`))})
 })
}
async function runQuestion(args) {
 return new Promise((resolve,reject)=>{
  const child=spawn('claude',args,{cwd:home,env,stdio:['pipe','pipe','pipe']});let out='',err='',buffer=''
  const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('Question runtime timed out: '+err.slice(-1500)+' / '+out.slice(-1500)))},90000)
  child.stderr.on('data',c=>err+=c)
  child.stdout.on('data',chunk=>{
   out+=chunk;buffer+=chunk
   while(buffer.includes('\n')){
    const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1)
    let event;try{event=JSON.parse(line)}catch{continue}
    if(event.type==='control_request'){
     const request=event.request
     const allowed=request?.tool_name==='AskUserQuestion'
     if(allowed){assert(request.input.questions[0].options.some(o=>o.label==='Website — Client'));questionAnswered=true}
     const response=allowed?{behavior:'allow',updatedInput:{...request.input,answers:{[request.input.questions[0].question]:expectedAnswer}}}:{behavior:'deny',message:'Only the fixture question is approved'}
     child.stdin.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:event.request_id,response}})+'\n')
    }
    if(event.type==='result')child.stdin.end()
   }
  })
  child.once('error',error=>{clearTimeout(timer);reject(error)})
  child.once('exit',code=>{clearTimeout(timer);code===0?resolve({out,err}):reject(new Error(`Question exit ${code}: ${err.slice(-1500)} / ${out.slice(-1500)}`))})
  child.stdin.write(JSON.stringify({type:'user',message:{role:'user',content:'/devspec:devspec.project choose'}})+'\n')
 })
}
try {
 if(!cancelMode){
  const prepared=JSON.parse((await run(process.execPath,[join(root,'hooks/scripts/devspec-project.mjs'),'prepare','--project',B.id])).out)
  assert.equal(prepared.ok,true);localId=prepared.local_id
  assert.equal(prepared.launch_command,`claude --session-id ${localId}`)
  await run(process.execPath,[join(root,'hooks/scripts/devspec-remote-connect.mjs'),'--local-id',localId,'--no-poller','--json'])
  assert.equal(readConversationProject(localId,{endpoint,home}).project.id,B.id)
 }
 const config=join(home,'mcp.json');writeFileSync(config,JSON.stringify({mcpServers:{devspec:{type:'http',url:endpoint,headers:{Authorization:'Bearer fixture-only-not-a-real-token'}}}}))
 const version=(await run('claude',['--version'])).out.trim()
 // The fixture does not implement Claude's autonomous safety classifier. Use
 // normal manual permissions with an exact read-only command grant, not bypass
 // permissions or a broad shell allowance. Project-scope denials remain tested.
 const statusCommand=`node ${JSON.stringify(join(root,'hooks/scripts/devspec-project.mjs'))} status`
 const common=['--plugin-dir',root,'--strict-mcp-config','--mcp-config',config,'--setting-sources','','--session-id',localId,'--model','sonnet','--permission-mode','manual','--allowedTools',`Bash(${statusCommand})`,'mcp__devspec__get_project_summary']
 const result=questionMode
  ? await runQuestion(['-p',...common,'--input-format','stream-json','--output-format','stream-json','--verbose','--permission-prompt-tool','stdio'])
  : await run('claude',['-p','/devspec:devspec.project status',...common,'--output-format','json'])
 assert(result.out.includes('PROJECT-HOOK-RUNTIME-PASS'),result.out.slice(-1800))
 const summaries=mcpCalls.filter(c=>c.name==='get_project_summary')
 if(cancelMode){assert.equal(summaries.length,0);assert.equal(mcpCalls.some(c=>c.name==='register_connection'),false);assert.equal(readConversationProject(localId,{endpoint,home}),null)}
 else {assert.equal(summaries.length,1,'conflicting explicit project must be denied before MCP');assert.equal(summaries[0].args.project_id,B.id,'ordinary MCP call must receive the saved conversation project')}
 assert(commandLoaded,'the installed native project command must be discovered and expanded')
 assert.equal(repositoryContextObserved,!cancelMode,'the actual model request must contain all 25 repository facts, and no cancelled-project context')
 if(questionMode){assert(questionAnswered,'the native AskUserQuestion must request an answer through the host protocol');assert(questionResultObserved,'the selected native answer must return to the workflow')}
 else {assert(statusScoped,'the Bash management helper must receive the firing host conversation identity: '+statusResult.slice(0,2000));assert(modelCalls>=4,'status, both tool attempts and a final answer must run; the host may make an additional completion request')}
 assert.equal(JSON.parse(readFileSync(join(root,'.claude-plugin/plugin.json'),'utf8')).name,'devspec')
 console.log(JSON.stringify({result:'PASS',host:version,pluginRoot:root,configuredConversation:localId,nativeCommandDiscovered:commandLoaded,repositoryContextObserved,...(questionMode?{nativeQuestionAnswered:questionAnswered,answerReturnedToWorkflow:questionResultObserved}:{managementHelperScoped:statusScoped,wrongProjectDenied:true}),ordinaryToolScoped:!cancelMode,cancelLeftUnconnected:cancelMode,scriptedProviderRequests:modelCalls,paidInference:0,liveDevspecRecords:0}))
} finally {server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(home,{recursive:true,force:true})}
