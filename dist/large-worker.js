import {makeLargeGrid} from './large-grid.js';
self.onmessage=event=>{
  try {
    const start=performance.now();
    const volume=makeLargeGrid(event.data.scale,fraction=>self.postMessage({type:'progress',fraction}));
    volume.stats.generationMs=performance.now()-start;
    const arrays=[volume.attributes,volume.bricks,volume.axisData,volume.foldData,volume.histogram,...volume.axes,volume.foldX,volume.foldY];
    self.postMessage({type:'ready',volume},arrays.map(a=>a.buffer));
  } catch(error){self.postMessage({type:'error',message:error.message});}
};
