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
// synchronously: a client that pipelines creates runs all of their handlers to the
// first await before any of them registers, so a check that reads only
// sessions.size lets every one through. shutdown() also reaps them, which it cannot
// do from the registry because they are not in it yet.
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
// close. stderr is diagnostics; it is never the JSON-RPC channel. Newlines are
// flattened so one failure stays one line.
async function abandon(session){
  await session.close();
  if(session.closeError)process.stderr.write(`sentiora: cleanup failed for session ${session.id}: ${String(session.closeError).replace(/[\r\n]+/g,' ')}\n`);
  sessions.delete(session.id);
}
async function abandonAll(deferred){for(const d of deferred??[])await d.rollback();}
// A create that cannot produce its first observation would sit in `inflight`
// forever: not in the registry, so terminal.close answers Unknown session, but
// still holding a slot. Only teardown could reclaim it. Bounded for the same
// reason close() is -- a failure must not permanently consume capacity.
const CREATE_OBSERVE_GRACE_MS=10000;
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
  try{s=new Session(child,terminal);}catch(e){try{child.kill();}catch{}try{terminal.dispose();}catch{}throw e;}
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
  const observation=(async()=>({...await s.observe(),owner:s.owner}))();
  // If the race below times out, the observation is still pending; swallow its
  // eventual rejection so it cannot surface as an unhandled one.
  observation.catch(()=>{});
  let timer;
  try{
    result=await Promise.race([
      observation,
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Session observation timed out')),CREATE_OBSERVE_GRACE_MS);}),
    ]);
  }catch(e){await record.rollback();throw e;}finally{clearTimeout(timer);}
  return {result,commit:()=>record.commit(),rollback:()=>record.rollback()};
}
// deferred is required rather than defaulted: a create pushed into a throwaway
// array is a session no caller can ever commit or roll back, which is precisely the
// leak this file exists to prevent. Checked before anything is spawned.
export async function dispatch(method,p,deferred){
  if(!Array.isArray(deferred))throw Error('dispatch requires a deferred sink');
  if(closing)throw Error('Server shutting down');
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
// Read-only view of creates that are spawned but not yet confirmed delivered.
export const inflightInfo=()=>[...inflight].map(r=>({pid:r.session.pid,settled:r.settled}));
let stdoutBroken=false;
// Without a listener, a failed write on stdout -- EPIPE once the client is gone --
// is an unhandled 'error' event that kills the host and every session with it. Only
// the flag is set here: the write callback is what reports delivery per response,
// so each in-flight create is settled by its own write rather than by a broadcast
// that could also settle one whose bytes were already accepted.
process.stdout.on('error',()=>{stdoutBroken=true;});
// The same argument applies to stderr, which this file writes diagnostics to from
// rollback and teardown paths -- exactly when the reader is most likely to be gone.
process.stderr.on('error',()=>{});
// Resolves true once stdout has accepted the bytes. write() returning true means
// "buffered", not "delivered": on a broken pipe the failure arrives later, through
// the callback, after a synchronous check would already have committed.
// The grace bound is a liveness valve, not a verdict -- it resolves TRUE, so a
// client that is merely slow to read keeps its session rather than having it killed
// underneath it. The cost is that after the bound expires the commit is no longer
// backed by a delivery confirmation and a later failure cannot undo it. That is the
// deliberate trade: killing a healthy client's session to protect against a
// hypothetical late EPIPE is the worse failure.
const DELIVERY_GRACE_MS=2000;
export function respond(payload){
  return new Promise(resolve=>{
    let line;
    try{line=JSON.stringify(payload)+'\n';}catch{resolve(false);return;}
    if(closing||stdoutBroken||process.stdout.destroyed||process.stdout.writableEnded){resolve(false);return;}
    // Both verdicts consult the same facts. The timer checks the flag because the
    // grace expiring says nothing about the transport; the callback ignores it
    // because a write whose own bytes were accepted must not be failed by a
    // *different* write's error -- that coupling is what round 1's finding N1 was
    // about, and leaving it here would reintroduce it in weakened form.
    const timer=setTimeout(()=>resolve(!stdoutBroken&&!process.stdout.destroyed),DELIVERY_GRACE_MS);
    try{process.stdout.write(line,error=>{clearTimeout(timer);resolve(!error);});}
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
  // abandon() rather than close() so a teardown that fails is reported the same way
  // an interactive close that fails is.
  await Promise.allSettled([...pending.map(r=>r.rollback()),...doomed.map(s=>abandon(s))]);
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
