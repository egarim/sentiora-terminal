import * as pty from 'node-pty';
import xterm from '@xterm/headless';
import {createInterface} from 'node:readline';
import {Session,dimensions} from './session.js';
const {Terminal}=xterm;
const sessions=new Map();
const keys={Enter:'\r',Escape:'\x1b',Tab:'\t',Backspace:'\x7f',Up:'\x1b[A',Down:'\x1b[B',Right:'\x1b[C',Left:'\x1b[D',CtrlC:'\x03'};
// node-pty's bundled-DLL ConPTY path is exposed so both providers can be
// compared, but it is NOT recommended and is not the default: measured over 30
// sessions it leaks one worker thread and ~6MB per session and leaves the host
// process unable to exit. See docs/validation/conpty-provider-comparison.md.
const conptyDllDefault=process.env.SENTIORA_CONPTY_DLL==='1';
async function dispatch(method,p={}){
  if(method==='initialize')return {protocolVersion:1,platform:process.platform,arch:process.arch,conptyDll:conptyDllDefault};
  if(method==='terminal.create'){
    if(sessions.size>=16)throw Error('Session limit');
    const {command,args=[],cwd=process.cwd(),cols=120,rows=40,conptyDll}=p;dimensions(cols,rows);
    if(typeof command!=='string'||!command||!Array.isArray(args)||args.some(a=>typeof a!=='string'))throw Error('Invalid command');
    if(conptyDll!==undefined&&typeof conptyDll!=='boolean')throw Error('Invalid conptyDll');
    const terminal=new Terminal({cols,rows,scrollback:2000,allowProposedApi:true});
    let child;try{child=pty.spawn(command,args,{name:'xterm-256color',cols,rows,cwd,env:process.env,useConptyDll:conptyDll??conptyDllDefault});}catch(e){terminal.dispose();throw e;}
    const s=new Session(child,terminal);sessions.set(s.id,s);return {...await s.observe(),owner:s.owner};
  }
  if(method==='terminal.list')return Promise.all([...sessions.values()].map(s=>s.observe()));
  const s=sessions.get(p.sessionId);if(!s)throw Error('Unknown session');
  switch(method){
    case 'terminal.observe':return s.observe();
    case 'terminal.type':return s.input(p);
    case 'terminal.key':if(!Object.hasOwn(keys,p.key))throw Error('Unknown key');return s.input({...p,text:keys[p.key]});
    case 'terminal.wait':return s.wait(p.afterRevision,p.timeoutMs);
    case 'terminal.resize':return s.resize(p.owner,p.cols,p.rows);
    case 'terminal.close':if(p.owner!==s.owner)throw Error('Ownership required');await s.close();sessions.delete(s.id);return true;
    default:throw Error('Unknown method');
  }
}
const rl=createInterface({input:process.stdin,crlfDelay:Infinity});
rl.on('line',async line=>{let req;try{req=JSON.parse(line);if(req.jsonrpc!=='2.0'||typeof req.method!=='string'||!Object.hasOwn(req,'id'))throw Error('Invalid request');const result=await dispatch(req.method,req.params);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\n');}catch(e){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req?.id??null,error:{code:-32000,message:e.message}})+'\n');}});
rl.on('close',async()=>{await Promise.allSettled([...sessions.values()].map(s=>s.close()));});
