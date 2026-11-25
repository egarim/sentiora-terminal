import * as pty from 'node-pty';
import xterm from '@xterm/headless';
import {createInterface} from 'node:readline';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Session,dimensions} from './session.js';
const {Terminal}=xterm;
export const sessions=new Map();
export const SESSION_LIMIT=16;
// Creates whose response has not been confirmed delivered yet. They count against
// SESSION_LIMIT, because readline emits every complete line of a chunk
// synchronously: a client that pipelines creates runs all of their handlers to
// the first await before any of them registers, so a check that reads only
// sessions.size lets every one of them through. shutdown() also reaps them, which
// it cannot do from the registry because they are not in it yet.
const inflight=new Set();
let closing=false;
const keys={Enter:'\r',Escape:'\x1b',Tab:'\t',Backspace:'\x7f',Up:'\x1b[A',Down:'\x1b[B',Right:'\x1b[C',Left:'\x1b[D',CtrlC:'\x03'};
// node-pty's bundled-DLL ConPTY path is exposed so both providers can be
// compared, but it is NOT recommended and is not the default: measured over 30
// sessions it leaks one worker thread and ~6MB per session and leaves the host
// process unable to exit. See docs/validation/conpty-provider-comparison.md.
const conptyDllDefault=process.env.SENTIORA_CONPTY_DLL==='1';
// "The slot is free" and "the child is dead" are different claims. close() absorbs
// cleanup failures so that a rejection cannot strand the registry entry, so report
// what it absorbed rather than letting a surviving process pass silently as a clean
// close. stderr is diagnostics; it is never the JSON-RPC channel.
async function abandon(session){
  await session.close();
  if(session.closeError)process.stderr.write(`sentiora: cleanup failed for session ${session.id}: ${session.closeError}\n`);
  sessions.delete(session.id);
}
async function abandonAll(deferred){for(const d of deferred)await d.rollback();}
// terminal.create is the only method that registers state, so it is the only one
// that can strand a session: the owner token travels in the create response, and a
// caller that never receives it can never close the session or free its slot. The
// session is therefore spawned and observed first and enters the registry only once
// the transport has confirmed those bytes -- commit() on success, rollback() on
// anything else.
async function createSession(p){
  if(sessions.size+inflight.size>=SESSION_LIMIT)throw Error('Session limit');
  const {command,args=[],cwd=process.cwd(),cols=120,rows=40,conptyDll}=p;dimensions(cols,rows);
  if(typeof command!=='string'||!command||!Array.isArray(args)||args.some(a=>typeof a!=='string'))throw Error('Invalid command');
  if(conptyDll!==undefined&&typeof conptyDll!=='boolean')throw Error('Invalid conptyDll');
  const terminal=new Terminal({cols,rows,scrollback:2000,allowProposedApi:true});
  let child;
  try{child=pty.spawn(command,args,{name:'xterm-256color',cols,rows,cwd,env:process.env,useConptyDll:conptyDll??conptyDllDefault});}
  catch(e){terminal.dispose();throw e;}
  let s;
  try{s=new Session(child,terminal);}catch(e){try{child.kill();}catch{}terminal.dispose();throw e;}
  const record={
    session:s,settled:false,
    commit(){
      if(this.settled)return null;
      this.settled=true;inflight.delete(this);
      // Teardown can begin while a response is still in flight. Registering then
      // would put the session somewhere nothing will ever drain it, so the
      // delivery guarantee yields to the shutdown guarantee.
      if(closing){void abandon(s);return null;}
      sessions.set(s.id,s);return s;
    },
    rollback(){if(this.settled)return;this.settled=true;inflight.delete(this);return abandon(s);},
  };
  inflight.add(record);
  let result;
  try{result={...await s.observe(),owner:s.owner};}catch(e){await record.rollback();throw e;}
  return {result,commit:()=>record.commit(),rollback:()=>record.rollback()};
}
// deferred is required rather than defaulted: a create pushed into a throwaway
// array is a session no caller can ever commit or roll back, which is precisely
// the leak this file exists to prevent.
export async function dispatch(method,p,deferred){
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
// Without a listener, a failed write on stdout -- EPIPE once the client is gone --
// is an unhandled 'error' event that kills the host and every session with it. It
// also invalidates every create still awaiting delivery confirmation, which would
// otherwise commit a session whose owner token went nowhere.
process.stdout.on('error',()=>{stdoutBroken=true;for(const record of [...inflight])void record.rollback();});
// A synchronous write() returning true means "buffered", not "delivered": on a
// broken pipe the failure arrives later as an 'error' event, by which point a
// synchronous check has already committed. Confirm through the write callback
// instead. The grace bound keeps a client that stopped reading from stalling the
// server indefinitely -- bytes still buffered at that point flush when it resumes,
// and a genuinely broken pipe errors far sooner than this.
const DELIVERY_GRACE_MS=2000;
export function respond(payload){
  return new Promise(resolve=>{
    let line;
    try{line=JSON.stringify(payload)+'\n';}catch{resolve(false);return;}
    if(closing||stdoutBroken||process.stdout.destroyed||process.stdout.writableEnded){resolve(false);return;}
    const timer=setTimeout(()=>resolve(true),DELIVERY_GRACE_MS);
    try{process.stdout.write(line,error=>{clearTimeout(timer);resolve(!error&&!stdoutBroken);});}
    catch{clearTimeout(timer);resolve(false);}
  });
}
// One JSON-RPC request. respond is injectable so the delivery-failure path can be
// provoked directly instead of being inferred from a broken pipe.
export async function handleRequest(line,respond_=respond){
  let req;const deferred=[];
  try{
    req=JSON.parse(line);
    if(req.jsonrpc!=='2.0'||typeof req.method!=='string'||!Object.hasOwn(req,'id'))throw Error('Invalid request');
    const result=await dispatch(req.method,req.params??{},deferred);
    // The confirmed response is the acknowledgement. A create that could not be
    // acknowledged must not become visible in the registry.
    if(!await respond_({jsonrpc:'2.0',id:req.id,result})){await abandonAll(deferred);return;}
    for(const d of deferred)d.commit();
  }catch(e){
    // Answer before tearing down: a rollback that stalls must not swallow the
    // client's error response.
    try{await respond_({jsonrpc:'2.0',id:req?.id??null,error:{code:-32000,message:e.message}});}catch{}
    await abandonAll(deferred);
  }
}
export async function shutdown(){
  closing=true;
  const doomed=[...sessions.values()];sessions.clear();
  const pending=[...inflight];inflight.clear();
  await Promise.allSettled([...pending.map(r=>r.rollback()),...doomed.map(s=>s.close())]);
}
function startStdioTransport(){
  const rl=createInterface({input:process.stdin,crlfDelay:Infinity});
  // Line handlers run concurrently, so a rejection escaping one would become an
  // unhandled rejection that takes the host and every session with it.
  rl.on('line',line=>{handleRequest(line).catch(error=>{process.stderr.write(`sentiora: request handler failed: ${error?.stack??error}\n`);});});
  rl.on('close',()=>{void shutdown();});
}
// Importable for tests without hijacking the importing process's stdio. Compared on
// realpath as well as the raw string: a launcher that hands over a symlinked or
// differently cased path would otherwise yield a server that reads requests and
// answers none -- a hang, not an error.
function isMainModule(){
  const entry=process.argv[1];
  if(!entry)return false;
  const self=fileURLToPath(import.meta.url);
  if(entry===self)return true;
  try{return realpathSync(entry)===realpathSync(self);}catch{return false;}
}
if(isMainModule())startStdioTransport();
