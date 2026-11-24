import { randomUUID } from 'node:crypto';
export function dimensions(cols,rows) {
  if (!Number.isInteger(cols)||!Number.isInteger(rows)||cols<2||cols>300||rows<2||rows>150) throw Error('Invalid dimensions');
}
export class Session {
  constructor(pty, terminal) {
    this.id=randomUUID(); this.owner=randomUUID(); this.pty=pty; this.terminal=terminal;
    this.revision=0; this.pending=Promise.resolve(); this.exit=null; this.closed=false;
    this.lastActivity=Date.now(); this.waiters=new Set();
    this.subscriptions=[
      pty.onData(data=>{if(!this.closed) this.pending=this.pending.then(()=>new Promise(resolve=>terminal.write(data,resolve))).then(()=>this.changed());}),
      pty.onExit(exit=>{this.exit=exit;this.changed();}),
      terminal.onData(data=>{if(!this.closed&&!this.exit)pty.write(data);})
    ];
  }
  changed(){this.revision++;this.lastActivity=Date.now();for(const wake of this.waiters)wake();}
  async observe(){
    await this.pending;
    const t=this.terminal,b=t.buffer.active;
    return {sessionId:this.id,revision:this.revision,running:!this.exit&&!this.closed,exit:this.exit,cols:t.cols,rows:t.rows,cursor:{x:b.cursorX,y:b.cursorY},screen:Array.from({length:t.rows},(_,i)=>b.getLine(b.baseY+i)?.translateToString(true)??'').join('\n'),idleMilliseconds:Date.now()-this.lastActivity};
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
  async close(){if(this.closed)return;this.closed=true;try{if(!this.exit)this.pty.kill();}finally{this.changed();await this.pending;for(const s of this.subscriptions)s.dispose();this.terminal.dispose();}}
}
