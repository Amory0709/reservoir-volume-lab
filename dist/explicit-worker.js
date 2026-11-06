import {makeExplicitGrid} from './explicit-grid.js';
import {attachBlockIndex,blockIndexTransfers} from './block-index.js';
self.onmessage=event=>{
  try{
    const volume=makeExplicitGrid(event.data.scale,(fraction,phase)=>self.postMessage({type:'progress',fraction:event.data.backend==='webgpu'?fraction:fraction*.98,phase}));
    if(event.data.backend!=='webgpu'){self.postMessage({type:'progress',fraction:.99,phase:'缓存断层块空间索引'});attachBlockIndex(volume);}
    self.postMessage({type:'ready',volume},[...['vertices','attributes','nodes','ranges','sortedPhi'].map(k=>volume[k].buffer),...blockIndexTransfers(volume)]);
  }catch(error){self.postMessage({type:'error',message:error.message||'显式网格生成失败，请选择较小规模。'});}
};
