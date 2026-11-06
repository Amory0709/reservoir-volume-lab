// A task boundary for nonblocking WebGL fence polling. MessageChannel avoids
// chaining zero-delay timers (which browsers clamp during long refinements).
export class GpuYield {
  constructor(){
    this.pending=[];this.closed=false;
    if(typeof MessageChannel!=='undefined'){
      this.channel=new MessageChannel();
      this.channel.port1.onmessage=()=>this.pending.shift()?.();
    }
  }
  next(){
    if(this.closed)return Promise.resolve();
    if(!this.channel)return new Promise(resolve=>setTimeout(resolve,0));
    return new Promise(resolve=>{this.pending.push(resolve);this.channel.port2.postMessage(0);});
  }
  dispose(){
    this.closed=true;this.channel?.port1.close();this.channel?.port2.close();
    for(const resolve of this.pending.splice(0))resolve();
  }
}
