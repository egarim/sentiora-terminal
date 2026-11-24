import test from 'node:test';
import assert from 'node:assert/strict';
import * as pty from 'node-pty';
import xterm from '@xterm/headless';
import {Session} from '../src/session.js';
test('real PTY redraw, input and exit',{timeout:30000},async()=>{
 const program="process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\\x1b[2J\\x1b[HREADY');process.stdin.once('data',d=>{process.stdout.write('\\x1b[2J\\x1b[HRECEIVED:'+d.toString());setTimeout(()=>process.exit(0),200);});";
 const t=new xterm.Terminal({cols:80,rows:24,allowProposedApi:true});
 const child=pty.spawn(process.execPath,['-e',program],{name:'xterm-256color',cols:80,rows:24,cwd:process.cwd(),env:process.env});
 const s=new Session(child,t);
 async function until(predicate){let snap=await s.observe();const deadline=Date.now()+10000;while(!predicate(snap)&&Date.now()<deadline)snap=await s.wait(snap.revision,250);assert.ok(predicate(snap),JSON.stringify(snap));return snap;}
 try{const ready=await until(x=>x.screen.includes('READY'));await s.input({owner:s.owner,revision:ready.revision,text:'x'});await until(x=>x.screen.includes('RECEIVED:x'));const done=await until(x=>!x.running);assert.equal(done.exit.exitCode,0);}finally{await s.close();}
});
