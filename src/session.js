import { randomUUID } from 'node:crypto';
import { Recording } from './recording.js';
// Upper bound on how long close() waits for the emulator write chain to settle.
// Normally the chain is already resolved and this timer is cleared immediately;
// it only elapses when a write callback never fires.
const CLOSE_GRACE_MS = 2000;
export function dimensions(cols,rows) {
  if (!Number.isInteger(cols)||!Number.isInteger(rows)||cols<2||cols>300||rows<2||rows>150) throw Error('Invalid dimensions');
}
export class Session {
  // Lifecycle states, in order: 'spawned' (child exists, nothing rendered yet)
  // -> 'operational' (the emulator has rendered at least one chunk) -> 'exited'
  // (child is gone, resources still held) -> 'released' (close() done).
  // There is deliberately no 'ready' state: whether the application is ready to
  // accept input is only knowable from an observable condition the caller
  // defines, such as a prompt appearing on screen. 'spawned' is not readiness.
  constructor(pty, terminal, options = {}) {
    this.id=randomUUID(); this.owner=randomUUID(); this.pty=pty; this.terminal=terminal;
    this.state='spawned';
    this.revision=0; this.pending=Promise.resolve(); this.exit=null; this.closed=false;
    this.lastActivity=Date.now(); this.waiters=new Set();
    this.writeErrors=0; this.lastWriteError=null;
    this.renderErrors=0; this.lastRenderError=null; this.closeError=null;
    // The recording's snapshot provider must be synchronous: it is called from
    // inside the write chain when the ring truncates, and awaiting this.pending
    // there would wait on the very chain that is running, deadlocking close() and
    // every observer with it.
    this.recording=new Recording({
      inputRecorded: options.recordInput === true,
      limit: options.recordBytes,
      cols: terminal?.cols, rows: terminal?.rows,
      snapshotProvider: ()=>this.screenSnapshot(),
    });
    this.subscriptions=[
      // A rejected emulator write must not poison `pending`: observe(), input(),
      // wait(), resize() and close() all await it, so one bad chunk would make the
      // session permanently unobservable and -- because close() awaits it too --
      // unclosable, stranding its registry slot (issue #14). The failure is counted
      // rather than swallowed so a caller can see that output was dropped.
      pty.onData(data=>{if(!this.closed) this.pending=this.pending
        .then(()=>new Promise(resolve=>terminal.write(data,resolve)))
        // Recorded only once the emulator has accepted the chunk, and not on the
        // error path. That ordering is what keeps the acceptance criterion true: a
        // truncation snapshot is taken from the screen as it stands, so it must not
        // be taken ahead of the chunk being recorded, and a chunk the emulator
        // dropped is not on the screen either -- replaying it would diverge from
        // observe(). renderErrors already reports what was dropped.
        .then(()=>{if(this.state==='spawned')this.state='operational';this.recording.recordOutput(data);},error=>{this.renderErrors++;this.lastRenderError={code:error?.code??null,message:error?.message??String(error)};})
        .then(()=>this.changed())}),
      pty.onExit(exit=>{this.exit=exit;if(this.state!=='released')this.state='exited';this.recording.recordExit(exit);this.changed();}),
      terminal.onData(data=>{if(!this.closed&&!this.exit)pty.write(data);})
    ];
    const guard=this.guardInputSocket();
    if(guard)this.subscriptions.push(guard);
  }
  // Read live rather than cached. node-pty 1.1.0 reports the child pid
  // synchronously from spawn, but 1.2.0-beta defers the pty connection until its
  // conout worker is ready and reports 0 until then, so caching in the
  // constructor would freeze that 0 for the life of the session. 0 maps to null
  // so a caller can distinguish "not known yet" from a real pid; the value is
  // stable once the child is producing output.
  get pid(){return this.pty?.pid||null;}
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
  // Synchronous screen read. observe() is this plus a wait for the write chain, and
  // the recording's truncation path needs it without that wait -- see the note on
  // snapshotProvider in the constructor.
  screenSnapshot(){
    const t=this.terminal,b=t.buffer.active;
    return {cols:t.cols,rows:t.rows,cursor:{x:b.cursorX,y:b.cursorY},screen:Array.from({length:t.rows},(_,i)=>b.getLine(b.baseY+i)?.translateToString(true)??'').join('\n')};
  }
  async observe(){
    await this.pending;
    return {sessionId:this.id,pid:this.pid,state:this.state,revision:this.revision,running:!this.exit&&!this.closed,exit:this.exit,writeErrors:this.writeErrors,renderErrors:this.renderErrors,idleMilliseconds:Date.now()-this.lastActivity,...this.screenSnapshot()};
  }
  async input({owner,revision,text}){
    await this.pending;
    if(this.closed||this.exit)throw Error('Session not running');
    if(owner!==this.owner)throw Error('Input ownership required');
    if(revision!==this.revision)throw Error('Stale observation');
    if(typeof text!=='string'||text.length>65536)throw Error('Invalid input');
    // Recorded only after every rejection above, so a refused keystroke is not
    // recorded as though it had been typed. recordInput is a no-op unless the
    // caller asked for input recording at create time.
    this.pty.write(text);this.recording.recordInput(text);this.changed();return {revision:this.revision};
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
    dimensions(cols,rows);this.pty.resize(cols,rows);this.terminal.resize(cols,rows);this.recording.recordResize(cols,rows);this.changed();return this.observe();
  }
  // Read-only live stream (issue #27). A watcher polls with the cursor it was last
  // given; it never needs the owner token and never receives one, and there is no
  // path from here to input().
  //
  // Deliberately a poll rather than a server-initiated notification: pushing
  // unsolicited lines on stdout would break the framing invariant WIN-15 pins (a
  // child must never be able to put a line on the RPC channel), and every existing
  // client parses stdout as responses. docs/desktop/living-terminal.md §9.1 already
  // flags the push variant as needing "a deliberate framing decision, not a
  // drive-by change", so it stays a proposal.
  async stream(afterSequence,timeout=1000){
    const cursor=afterSequence===undefined||afterSequence===null?0:afterSequence;
    if(!Number.isSafeInteger(cursor)||cursor<0)throw Error('Invalid sequence');
    if(!Number.isFinite(timeout)||timeout<0)throw Error('Invalid stream');
    await this.pending;
    // Falling behind the ring is reported rather than papered over: a gap-free
    // replay from a stale cursor is impossible, so the caller gets the current
    // screen and a new cursor instead of a partial history that looks complete.
    const resync=this.recording.missedEvents(cursor);
    const includeSnapshot=cursor===0||resync;
    const from=resync?this.recording.latestSequence:cursor;
    let selected=this.recording.eventsAfter(from,{includeInput:false});
    // Waiting reuses the same waiter set as wait(), so a stream poll is woken by the
    // next change instead of spinning, and the bound is capped identically.
    if(!selected.events.length&&!this.exit&&!this.closed){
      await new Promise(resolve=>{
        const wake=()=>{clearTimeout(timer);this.waiters.delete(wake);resolve();};
        const timer=setTimeout(wake,Math.min(timeout,30000));this.waiters.add(wake);
      });
      await this.pending;
      selected=this.recording.eventsAfter(from,{includeInput:false});
    }
    const events=selected.events;
    const latest=this.recording.latestSequence;
    return {
      sessionId:this.id,state:this.state,revision:this.revision,running:!this.exit&&!this.closed,exit:this.exit,
      // Never the owner token: a watcher must not be able to type. Pinned by test.
      resync,
      snapshot:includeSnapshot?await this.observe():null,
      events,
      nextSequence:events.length?events[events.length-1].seq:(resync?latest:cursor),
      oldestSequence:this.recording.oldestSequence,latestSequence:latest,
      truncated:this.recording.truncated,droppedEvents:this.recording.droppedEvents,
      inputRecorded:this.recording.inputRecorded,
    };
  }
  // Owner-gated: unlike the stream this can contain keystrokes, which is exactly
  // what may hold a secret. The ownership check lives in dispatch next to the other
  // gated methods.
  recordingPayload(){
    const {events}=this.recording.eventsAfter(0,{byteCap:Infinity,includeInput:true});
    return {...this.recording.toJSON(),sessionId:this.id,revision:this.revision,events};
  }
  // kill() is required even after a natural exit: on Windows node-pty only
  // disposes its ConPTY conout worker thread from kill(), and a live worker
  // keeps the host event loop alive forever.
  // close() neither throws nor hangs. Its callers deregister on the assumption
  // that cleanup completed, so a rejection here -- a poisoned write chain, a
  // disposed handle -- would abort that deregistration and strand the slot
  // (issue #14). A write chain that never settles strands it just as thoroughly
  // by never returning, so the wait is bounded: an emulator that does not invoke
  // its write callback must not be able to hang terminal.close forever. The first
  // failure is recorded rather than thrown so the caller can report it.
  async close(){
    if(this.closed)return;
    this.closed=true;
    try{this.pty.kill();}catch(error){this.noteCloseError(error);}
    this.state='released';this.changed();
    let timer;
    try{
      await Promise.race([this.pending,new Promise(resolve=>{timer=setTimeout(resolve,CLOSE_GRACE_MS);})]);
    }catch(error){this.noteCloseError(error);}finally{clearTimeout(timer);}
    for(const s of this.subscriptions){try{s.dispose();}catch(error){this.noteCloseError(error);}}
    // The emulator is disposed but its buffer stays readable, and observing a
    // released session is a supported contract: a caller can still inspect the
    // last screen without keeping the session open. Do not add a `closed` guard to
    // observe() -- test/windows-native.test.js pins that behaviour.
    try{this.terminal.dispose();}catch(error){this.noteCloseError(error);}
  }
  noteCloseError(error){if(!this.closeError)this.closeError=error?.message??String(error);}
}
