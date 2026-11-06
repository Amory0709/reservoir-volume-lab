// Visit central regions first, adapting GPU batch size without gaps/overlaps.
export const MAX_VOLUME_TILE_PIXELS=65536;
export function* volumeTiles(width,height,budget){
  const regions=[];
  for(let y=0;y<height;y+=256)for(let x=0;x<width;x+=256){
    const w=Math.min(256,width-x),h=Math.min(256,height-y);
    regions.push({x,y,w,h,d:(x+w/2-width/2)**2+(y+h/2-height/2)**2});
  }
  regions.sort((a,b)=>a.d-b.d);
  for(const region of regions){
    for(let y=region.y;y<region.y+region.h;){
      const h=Math.min(region.y+region.h-y,2**Math.max(4,Math.min(8,Math.floor(Math.log2(budget())/2))));
      for(let x=region.x;x<region.x+region.w;){
        const w=Math.min(region.x+region.w-x,2**Math.max(0,Math.min(8,Math.floor(Math.log2(budget()/h)))));
        yield {x,y,w,h};x+=w;
      }
      y+=h;
    }
  }
}

export function volumePatch(tile,width,height,displayWidth,displayHeight){
  // Refresh a one-texel halo too: linear filtering can cross the tile boundary.
  const x=Math.max(0,Math.floor((tile.x-1)*displayWidth/width));
  const y=Math.max(0,Math.floor((tile.y-1)*displayHeight/height));
  const right=Math.min(displayWidth,Math.ceil((tile.x+tile.w+1)*displayWidth/width));
  const top=Math.min(displayHeight,Math.ceil((tile.y+tile.h+1)*displayHeight/height));
  return {x,y,w:right-x,h:top-y};
}
