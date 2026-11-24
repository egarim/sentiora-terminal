import { randomUUID } from 'node:crypto';
export function dimensions(cols,rows) {
  if (!Number.isInteger(cols)||!Number.isInteger(rows)||cols<2||cols>300||rows<2||rows>150) throw Error('Invalid dimensions');
}
export class Session {
  // Lifecycle states, in order: 'spawned' (child pid known, nothing rendered
  // yet) -> 'operational' (the emulator has rendered at least one chunk) ->
  // 'exited' (child is gone, resources still held) -> 'released' (close() done).
  // There is deliberately no 'ready' state: whether the application is ready to
  // accept input is only knowable from an observable condition the caller
  // defines, such as a prompt appearing on screen. 'spawned' is not readiness.
  constructor(pty, terminal) {
    this.id=randomUUID(); this.owner=randomUUID(); this.pty=pty; this.terminal=terminal;
    this.pid=pty.pid??null; this.state='spawned';
    this.revision=0; this.pending=Promise.resolve(); this.exit=null; this.closed=false;
    this.lastActivity=Date.now(); this.waiters=new Set();
    this.writeErrors=0; this.lastWriteError=null;
    this.subscriptions=[
      pty.onData(data=>{if(!this.closed) this.pending=this.pending.then(()=>new Promise(resolve=>terminal.write(data,resolve))).then(()=>{if(this.state==='spawned')this.state='operational';this.changed();})}),
      pty.onExit(exit=>{this.exit=exit;if(this.state!=='released')this.state='exited';this.changed();}),
      terminal.onData(data=>{if(!this.closed&&!this.exit)pty.write(data);})
    ];
    const guard=this.guardInputSocket();
    if(guard)this.subscriptions.push(guard);
  }
  // node-pty guards its ConPTY output socket but attaches no 'error' listener to
  // the input socket, so an asynchronous write failure -- EAGAIN once the input
  // pipe is full, EINVAL once the child is gone -- surfaces as an unhandled
  // 'error' event that kills the host process and every other session with it.
  // A single failed terminal.type must not be able to do that. Reached
  // defensively: if node-pty renames these internals the guard no-ops instead of
  // throwing. Tracked as writeErrors so a caller can see that input was lost.
  guardInputSocket(){
    const socket=this.pty?._agent?.inSocket;
    if(!socket||typeof socket.on!=='function')return null;
    const onError=error=>{this.writeErrors++;this.lastWriteError={code:error?.code??null,message:error?.message??String(error)};this.changed();};
    socket.on('error',onError);
    return {dispose:()=>{socket.removeListener('error',onError);}};
  }
  changed(){this.revision++;this.lastActivity=Date.now();for(const wake of this.waiters)wake();}
  async observe(){
    await this.pending;
    const t=this.terminal,b=t.buffer.active;
    return {sessionId:this.id,pid:this.pid,state:this.state,revision:this.revision,running:!this.exit&&!this.closed,exit:this.exit,cols:t.cols,rows:t.rows,writeErrors:this.writeErrors,cursor:{x:b.cursorX,y:b.cursorY},screen:Array.from({length:t.rows},(_,i)=>b.getLine(b.baseY+i)?.translateToString(true)??'').join('\n'),idleMilliseconds:Date.now()-this.lastActivity};
  }
  async input({owner,revision,text}){
    await this.pending;
    if(this.closed||this.exit)throw Error('Session not running');
    if(owner!==this.owner)throw Error('Input ownership required');
    if(revision!==this.revision)throw Error('Stale observation');
    if(typeof text!=='string'||text.length>65536)throw Error('Invalid input');
    this.pty.write(text);this.changed();return {revision:this.revision};
  }
  async wait(after,timeout=1000){
    if(!Number.isSafeInteger(after)||after<0||!Number.isFinite(timeout)||timeout<0)throw Error('Invalid wait');
    await this.pending;
    if(this.revision===after&&!this.exit&&!this.closed)await new Promise(resolve=>{
      const wake=()=>{clearTimeout(timer);this.waiters.delete(wake);resolve();};
      const timer=setTimeout(wake,Math.min(timeout,30000));this.waiters.add(wake);
    });
    return this.observe();
  }
  async resize(owner,cols,rows){
    await this.pending;
    if(owner!==this.owner||this.closed||this.exit)throw Error('Resize denied');
    dimensions(cols,rows);this.pty.resize(cols,rows);this.terminal.resize(cols,rows);this.changed();return this.observe();
  }
  // kill() is required even after a natural exit: on Windows node-pty only
  // disposes its ConPTY conout worker thread from kill(), and a live worker
  // keeps the host event loop alive forever.
  async close(){if(this.closed)return;this.closed=true;try{this.pty.kill();}catch{}finally{this.state='released';this.changed();await this.pending;for(const s of this.subscriptions)s.dispose();this.terminal.dispose();}}
}
