import {makeExplicitGrid} from './explicit-grid.js';
self.onmessage=event=>{
  try{
    const volume=makeExplicitGrid(event.data.scale,(fraction,phase)=>self.postMessage({type:'progress',fraction,phase}));
    self.postMessage({type:'ready',volume},['vertices','attributes','nodes','ranges','sortedPhi'].map(k=>volume[k].buffer));
  }catch(error){self.postMessage({type:'error',message:error.message||'显式网格生成失败，请选择较小规模。'});}
};
