/** One asynchronous GPU producer; retain only the newest requested frame.
 * In-flight work must finish its fence, then observes cancelled() before
 * submitting another chunk. No parallel render jobs or unbounded draw queue.
 */
export class LatestRenderQueue {
  constructor(render){this.render=render;this.revision=0;this.pending=null;this.running=false;this.disposed=false;}
  request(payload){
    if(this.disposed)return Promise.resolve(false);
    this.cancel();const revision=this.revision;
    const result=new Promise((resolve,reject)=>{this.pending={payload,revision,resolve,reject};});
    if(!this.running)this.pump();return result;
  }
  cancel(){this.revision++;if(this.pending)this.pending.resolve(false);this.pending=null;}
  async pump(){
    this.running=true;
    try{while(this.pending&&!this.disposed){
      const job=this.pending;this.pending=null;
      const cancelled=()=>this.disposed||job.revision!==this.revision;
      try{const done=await this.render(job.payload,cancelled);job.resolve(done!==false&&!cancelled());}
      catch(error){if(cancelled())job.resolve(false);else job.reject(error);}
    }}finally{this.running=false;}
  }
  dispose(){this.disposed=true;this.cancel();}
}
