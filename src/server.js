import * as pty from 'node-pty';
import xterm from '@xterm/headless';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {Session,dimensions} from './session.js';
const {Terminal}=xterm;
export const sessions=new Map();
export const SESSION_LIMIT=16;
const keys={Enter:'\r',Escape:'\x1b',Tab:'\t',Backspace:'\x7f',Up:'\x1b[A',Down:'\x1b[B',Right:'\x1b[C',Left:'\x1b[D',CtrlC:'\x03'};
// node-pty's bundled-DLL ConPTY path is exposed so both providers can be
// compared, but it is NOT recommended and is not the default: measured over 30
// sessions it leaks one worker thread and ~6MB per session and leaves the host
// process unable to exit. See docs/validation/conpty-provider-comparison.md.
const conptyDllDefault=process.env.SENTIORA_CONPTY_DLL==='1';
// Releasing a session must never throw. Every caller deregisters on the
// assumption that cleanup completed, so a rejection escaping close() would leave
// the registry entry -- and the slot it occupies -- behind for the life of the
// process (issue #14).
async function abandon(session){try{await session.close();}catch{}sessions.delete(session.id);}
async function abandonAll(deferred){for(const d of deferred)await d.rollback();}
// terminal.create is the only method that registers state, so it is the only one
// that can strand a session: the owner token travels in the create response, and
// a caller that never receives it can never close the session or free its slot.
// The session is therefore spawned and observed first and enters the registry
// only once the transport has accepted those bytes -- commit() on success,
// rollback() on anything else.
async function createSession(p){
  if(sessions.size>=SESSION_LIMIT)throw Error('Session limit');
  const {command,args=[],cwd=process.cwd(),cols=120,rows=40,conptyDll}=p;dimensions(cols,rows);
  if(typeof command!=='string'||!command||!Array.isArray(args)||args.some(a=>typeof a!=='string'))throw Error('Invalid command');
  if(conptyDll!==undefined&&typeof conptyDll!=='boolean')throw Error('Invalid conptyDll');
  const terminal=new Terminal({cols,rows,scrollback:2000,allowProposedApi:true});
  let child;try{child=pty.spawn(command,args,{name:'xterm-256color',cols,rows,cwd,env:process.env,useConptyDll:conptyDll??conptyDllDefault});}catch(e){terminal.dispose();throw e;}
  const s=new Session(child,terminal);
  let result;
  try{result={...await s.observe(),owner:s.owner};}catch(e){await abandon(s);throw e;}
  return {result,commit(){sessions.set(s.id,s);return s;},rollback:()=>abandon(s)};
}
// deferred collects the create promises a request produced so the transport can
// commit or roll them back once it knows whether the response was delivered.
export async function dispatch(method,p={},deferred=[]){
  if(method==='initialize')return {protocolVersion:1,platform:process.platform,arch:process.arch,conptyDll:conptyDllDefault};
  if(method==='terminal.create'){const created=await createSession(p);deferred.push(created);return created.result;}
  if(method==='terminal.list')return Promise.all([...sessions.values()].map(s=>s.observe()));
  const s=sessions.get(p.sessionId);if(!s)throw Error('Unknown session');
  switch(method){
    case 'terminal.observe':return s.observe();
    case 'terminal.type':return s.input(p);
    case 'terminal.key':if(!Object.hasOwn(keys,p.key))throw Error('Unknown key');return s.input({...p,text:keys[p.key]});
    case 'terminal.wait':return s.wait(p.afterRevision,p.timeoutMs);
    case 'terminal.resize':return s.resize(p.owner,p.cols,p.rows);
    case 'terminal.close':if(p.owner!==s.owner)throw Error('Ownership required');await abandon(s);return true;
    default:throw Error('Unknown method');
  }
}
let stdoutBroken=false;
// Without a listener, a failed write on stdout -- EPIPE once the client is gone
// -- is an unhandled 'error' event that kills the host and every session with it.
process.stdout.on('error',()=>{stdoutBroken=true;});
// Returns false when the payload could not be handed to the transport, which is
// what tells handleRequest to roll back rather than register.
export function respond(payload){
  if(stdoutBroken||process.stdout.destroyed||process.stdout.writableEnded)return false;
  try{process.stdout.write(JSON.stringify(payload)+'\n');return true;}catch{return false;}
}
// One JSON-RPC request. respond is injectable so the delivery-failure path can be
// tested directly instead of being inferred from a broken pipe.
export async function handleRequest(line,respond_=respond){
  let req;const deferred=[];
  try{
    req=JSON.parse(line);
    if(req.jsonrpc!=='2.0'||typeof req.method!=='string'||!Object.hasOwn(req,'id'))throw Error('Invalid request');
    const result=await dispatch(req.method,req.params??{},deferred);
    // The delivered response is the acknowledgement. A create that could not be
    // acknowledged must not become visible in the registry.
    if(!respond_({jsonrpc:'2.0',id:req.id,result})){await abandonAll(deferred);return;}
    for(const d of deferred)d.commit();
  }catch(e){
    await abandonAll(deferred);
    respond_({jsonrpc:'2.0',id:req?.id??null,error:{code:-32000,message:e.message}});
  }
}
export async function shutdown(){
  const doomed=[...sessions.values()];sessions.clear();
  await Promise.allSettled(doomed.map(s=>s.close()));
}
function startStdioTransport(){
  const rl=createInterface({input:process.stdin,crlfDelay:Infinity});
  rl.on('line',line=>{void handleRequest(line);});
  rl.on('close',()=>{void shutdown();});
}
// Importable for tests without hijacking the importing process's stdio.
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)startStdioTransport();
