import * as pty from 'node-pty';
import xterm from '@xterm/headless';
import {createInterface} from 'node:readline';
import {randomBytes} from 'node:crypto';
import {existsSync,realpathSync,statSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Session,dimensions} from './session.js';
import {sessionEnv,envValidationError} from './env.js';
import {SESSION_SCROLLBACK} from './recording.js';
const {Terminal}=xterm;
export const sessions=new Map();
export const SESSION_LIMIT=16;
// Ceiling on a per-session recording cap. A caller may ask for less; it may not ask
// for more, because an unbounded recording is precisely the unbounded memory growth
// issue #27 requires be impossible.
export const RECORD_BYTES_MAX=16*1024*1024;
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
  mailboxes.delete(session.id);
  // An edge dies with either end: a capability left behind would let the surviving end post
  // into a mailbox that will never be drained again.
  for(const [capability,edge] of edges)if(edge.parent===session.id||edge.child===session.id)edges.delete(capability);
  if(session.closeError)process.stderr.write(`sentiora: cleanup failed for session ${session.id}: ${String(session.closeError).replace(/[\r\n]+/g,' ')}\n`);
  sessions.delete(session.id);
}
async function abandonAll(deferred){for(const d of deferred??[])await d.rollback();}
// A create that cannot produce its first observation would sit in `inflight`
// forever: not in the registry, so terminal.close answers Unknown session, but
// still holding a slot. Only teardown could reclaim it. Bounded for the same
// reason close() is -- a failure must not permanently consume capacity.
const CREATE_OBSERVE_GRACE_MS=10000;
// What CreateProcess can run is CreateProcess's decision, not this runtime's. An absolute
// path is allowed through when it names an existing file; a real non-image then fails
// inside connect() with ERROR_BAD_EXE_FORMAT, which scripts/patch-node-pty.mjs now cleans
// up, so refusing it here buys nothing and costs capability.
//
// An allowlist of .exe/.com/.bat/.cmd was tried and was wrong: measured, CreateProcess runs
// a valid PE named tool.bin or tool.scr, so the allowlist refused spawns that worked before
// it existed. The `.exe` fallback stays because CreateProcess appends that extension itself
// when the path has none of its own.
function win32Executable(command){
  try{if(statSync(command).isFile())return true;}catch{}
  try{return statSync(`${command}.exe`).isFile();}catch{return false;}
}
// Cross-session messaging (issue #34): a sequenced entry in a bounded, host-relayed queue --
// never keystrokes in the target's PTY. Keeping it off the PTY is the whole point: a message
// must not be rendered into scrollback or the recording, must not be erased by an ANSI
// repaint, and must never be mistakable for human input.
//
// The capability is minted per session and is deliberately NOT the owner token: holding it
// authorises messages only. There is no path from either method below to s.input(), so a
// session cannot type into another session just because it can send it a message.
const MAILBOX_MAX_BYTES=64*1024;      // one message, measured as its JSON encoding
const MAILBOX_DEPTH=256;              // queued per session; the oldest is dropped past this
const MAILBOX_POSTS_PER_SECOND=100;   // one sender cannot exhaust another's memory
const MAILBOX_MAX_WAIT_MS=30000;
const mailboxes=new Map();
// Parent/child edges (issue #35). One capability per edge, accepted at either end and
// nowhere else -- which is what makes "no sibling-to-sibling, no broadcast" structural
// rather than a policy someone could forget: a sibling never holds the edge's capability.
const edges=new Map();
function edgeCapability(){return randomBytes(24).toString('hex');}
function newMailbox(){return {capability:randomBytes(24).toString('hex'),queue:[],next:1,dropped:0,waiters:new Set(),recent:[]};}
function acceptsCapability(sessionId,capability){
  if(typeof capability!=='string')return false;
  const own=mailboxes.get(sessionId);
  if(own&&capability===own.capability)return true;
  const edge=edges.get(capability);
  return Boolean(edge)&&(edge.parent===sessionId||edge.child===sessionId);
}
function mailboxFor(p){
  const mailbox=mailboxes.get(p?.sessionId);
  if(!mailbox)throw Error('Unknown session');
  if(!acceptsCapability(p.sessionId,p.capability))throw Error('Mailbox capability required');
  return mailbox;
}
function mailboxDrain(mailbox,after){
  return {messages:mailbox.queue.filter(m=>m.sequence>after),nextSequence:mailbox.next-1,dropped:mailbox.dropped};
}
function mailboxPost(mailbox,payload){
  let encoded;
  try{encoded=JSON.stringify(payload);}catch{throw Error('Invalid message');}
  if(typeof encoded!=='string')throw Error('Invalid message');
  if(encoded.length>MAILBOX_MAX_BYTES)throw Error('Message too large');
  const now=Date.now();
  mailbox.recent=mailbox.recent.filter(at=>now-at<1000);
  if(mailbox.recent.length>=MAILBOX_POSTS_PER_SECOND)throw Error('Too many messages');
  mailbox.recent.push(now);
  const sequence=mailbox.next++;
  mailbox.queue.push({sequence,payload});
  // Dropped, never reordered: the gap is reported through `dropped`, the same way a
  // stream reports resync rather than silently losing bytes.
  if(mailbox.queue.length>MAILBOX_DEPTH){mailbox.queue.shift();mailbox.dropped+=1;}
  for(const wake of [...mailbox.waiters])wake();
  return {sequence,dropped:mailbox.dropped};
}
function mailboxWait(mailbox,afterSequence,timeoutMs){
  const after=Number.isSafeInteger(afterSequence)&&afterSequence>0?afterSequence:0;
  if(mailbox.queue.some(m=>m.sequence>after))return Promise.resolve(mailboxDrain(mailbox,after));
  const wait=Math.max(0,Math.min(Number.isSafeInteger(timeoutMs)?timeoutMs:0,MAILBOX_MAX_WAIT_MS));
  return new Promise(resolve=>{
    let timer;
    const finish=()=>{mailbox.waiters.delete(finish);clearTimeout(timer);resolve(mailboxDrain(mailbox,after));};
    timer=setTimeout(finish,wait);
    // Unref'd so a pending long poll can never be the reason the host cannot exit.
    if(typeof timer.unref==='function')timer.unref();
    mailbox.waiters.add(finish);
  });
}
// terminal.create is the only method that registers state, so it is the only one
// that can strand a session: the owner token travels in the create response, and a
// caller that never receives it can never close the session or free its slot. The
// session is therefore spawned and observed first and enters the registry only once
// the transport has confirmed those bytes -- commit() on success, rollback() on
// anything else.
async function createSession(p){
  if(sessions.size+inflight.size>=SESSION_LIMIT)throw Error('Session limit');
  const {command,args=[],cwd=process.cwd(),cols=120,rows=40,conptyDll,env,recordInput,recordBytes,parent}=p;dimensions(cols,rows);
  if(typeof command!=='string'||!command||!Array.isArray(args)||args.some(a=>typeof a!=='string'))throw Error('Invalid command');
  if(conptyDll!==undefined&&typeof conptyDll!=='boolean')throw Error('Invalid conptyDll');
  // Keystrokes can carry secrets, so recording them is opt-in and the default is
  // off. Validated like conptyDll rather than coerced: a caller passing "false" as a
  // string must be told it was wrong, not silently given input recording.
  if(recordInput!==undefined&&typeof recordInput!=='boolean')throw Error('Invalid recordInput');
  // Per-session recording cap. Configurable rather than fixed for two reasons: a
  // caller keeping long sessions as evidence wants more history than a caller
  // watching a short one, and the truncation path -- the one that decides whether a
  // replay is still exact -- cannot be tested end to end through a real PTY at the
  // default 1 MiB without pushing a megabyte of output through ConPTY in CI.
  // Capped so a caller cannot ask the host for unbounded memory, which is the thing
  // issue #27 explicitly requires be impossible.
  if(recordBytes!==undefined){
    if(!Number.isSafeInteger(recordBytes)||recordBytes<1024)throw Error('Invalid recordBytes');
    if(recordBytes>RECORD_BYTES_MAX)throw Error('Invalid recordBytes');
  }
  // Validated before anything is spawned, and the message names no value: an error
  // that quoted the offending entry would leak the secret it was rejecting into a
  // JSON-RPC response and every log downstream of it.
  const envError=envValidationError(env);if(envError)throw Error(envError);
  // A spawn that fails inside node-pty's Windows connect() leaks its ConPTY worker: the
  // worker is started before CreateProcess runs, and on failure the caller never receives
  // a terminal to kill, so the host can never exit (WIN-21: measured 20s forced shutdown
  // after a bad cwd; WIN-22: the same leak from a command that exists but is not an
  // executable image). Both cases are decidable here, before anything is created, so
  // both are refused here. The message names no value for the same reason as above.
  if(process.platform==='win32'){
    let usableCwd=false;
    try{usableCwd=statSync(cwd).isDirectory();}catch{}
    if(!usableCwd)throw Error('Invalid cwd');
    if(isAbsolute(command)&&!win32Executable(command))throw Error('Invalid command');
  }
  // A parent edge (issue #35) is decided before anything is spawned, like the cwd and the
  // command: an unknown parent must not leave a child process behind. The capability travels
  // to the child through its env allowlist, never through an inherited owner token.
  let edge=null;
  if(parent!==undefined){
    if(typeof parent!=='string'||!sessions.has(parent))throw Error('Unknown parent');
    edge={parent,child:null,capability:edgeCapability()};
  }
  const terminal=new Terminal({cols,rows,scrollback:SESSION_SCROLLBACK,allowProposedApi:true});
  let child;
  const childEnv=edge?sessionEnv({...env,SENTIORA_MAILBOX_CAPABILITY:edge.capability,SENTIORA_PARENT_SESSION:edge.parent}):sessionEnv(env);
  try{child=pty.spawn(command,args,{name:'xterm-256color',cols,rows,cwd,env:childEnv,useConptyDll:conptyDll??conptyDllDefault});}
  catch(e){terminal.dispose();throw e;}
  let s;
  try{s=new Session(child,terminal,{recordInput:recordInput===true,recordBytes});}catch(e){try{child.kill();}catch{}try{terminal.dispose();}catch{}throw e;}
  const mailbox=newMailbox();
  const record={
    session:s,settled:false,
    commit(){
      if(this.settled)return null;
      this.settled=true;inflight.delete(this);
      // Teardown can begin while a response is still in flight. Registering then
      // would put the session somewhere nothing will ever drain it, so the
      // delivery guarantee yields to the shutdown guarantee.
      if(closing){void abandon(s);return null;}
      if(edge){edge.child=s.id;edges.set(edge.capability,edge);}
      sessions.set(s.id,s);mailboxes.set(s.id,mailbox);return s;
    },
    rollback(){if(this.settled)return;this.settled=true;inflight.delete(this);return abandon(s);},
  };
  inflight.add(record);
  let result;
  const observation=(async()=>({...await s.observe(),owner:s.owner,mailbox:mailbox.capability,...(edge?{childMailbox:edge.capability}:{})}))();
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
  // `stream` advertises the sequence-numbered read-only subscription added for
  // issue #27, so a client can feature-detect it instead of probing for an Unknown
  // method error. Additive: protocolVersion stays 1 because nothing existing
  // changed shape.
  if(method==='initialize')return {protocolVersion:1,platform:process.platform,arch:process.arch,conptyDll:conptyDllDefault,stream:1,recording:1,mailbox:1};
  if(method==='terminal.create'){const created=await createSession(p);deferred.push(created);return created.result;}
  if(method==='terminal.list')return Promise.all([...sessions.values()].map(s=>s.observe()));
  const s=sessions.get(p.sessionId);if(!s)throw Error('Unknown session');
  switch(method){
    case 'terminal.observe':return s.observe();
    case 'terminal.type':return s.input(p);
    case 'terminal.key':if(!Object.hasOwn(keys,p.key))throw Error('Unknown key');return s.input({...p,text:keys[p.key]});
    case 'terminal.wait':return s.wait(p.afterRevision,p.timeoutMs);
    // Read-only, so ungated exactly like observe and wait: a watcher does not hold
    // the owner token and must not need one. It receives events with input filtered
    // out at the source, so there is no path from here to keystrokes either.
    case 'terminal.stream':return s.stream(p.afterSequence,p.timeoutMs);
    // Messaging, not input: mailboxFor() checks a capability minted for messages alone, so
    // neither case can reach s.input() and neither returns the owner token.
    case 'terminal.post':return mailboxPost(mailboxFor(p),p.payload);
    case 'terminal.mailbox':return mailboxWait(mailboxFor(p),p.afterSequence,p.timeoutMs);
    // Gated, unlike the stream: a recording can contain what was typed, which is
    // precisely what may hold a secret.
    case 'terminal.recording':if(p.owner!==s.owner)throw Error('Ownership required');return s.recordingPayload();
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
