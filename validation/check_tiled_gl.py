"""Actual GLES: tiled FBO output must equal the full draw, including grid lines."""
import check_explicit_gl as r
from check_explicit_gl import *
gen_fbo=gl('glGenFramebuffers',None,[I,c.POINTER(U)]);bind_fbo=gl('glBindFramebuffer',None,[U,U]);attach_fbo=gl('glFramebufferTexture2D',None,[U,U,U,U,I])
status_fbo=gl('glCheckFramebufferStatus',U,[U]);blit=gl('glBlitFramebuffer',None,[I,I,I,I,I,I,I,I,U,U])
enable=gl('glEnable',None,[U]);disable=gl('glDisable',None,[U]);scissor=gl('glScissor',None,[I,I,I,I])
color=U();gen(1,c.byref(color));active(0x84c7);bind(0xde1,color)
for a,b in [(0x2801,0x2601),(0x2800,0x2601),(0x2802,0x812f),(0x2803,0x812f)]:param(0xde1,a,b)
tex2(0xde1,0,0x8058,w,h,0,0x1908,0x1401,None)
fbo=U();gen_fbo(1,c.byref(fbo));bind_fbo(0x8d40,fbo);attach_fbo(0x8d40,0x8ce0,0xde1,color,0);assert status_fbo(0x8d40)==0x8cd5
bind_fbo(0x8d40,0);original_draw=r.draw

def tiled_draw(mode,start,count):
    bind_fbo(0x8d40,fbo);enable(0x0c11)
    for y in range(0,h,17):
        for x in range(0,w,17):
            scissor(x,y,min(17,w-x),min(17,h-y));original_draw(mode,start,count);finish()
    disable(0x0c11);bind_fbo(0x8ca8,fbo);bind_fbo(0x8ca9,0)
    blit(0,0,w,h,0,0,w,h,0x4000,0x2601);bind_fbo(0x8d40,0)

def variable_draw(mode,start,count):
    # Irregular rows and widths, including one-pixel strips, exercise the
    # scissor boundaries used by within-frame batch adaptation.
    bind_fbo(0x8d40,fbo);enable(0x0c11);y=0;row=0;tile=0
    while y<h:
        th=min([32,16,47][row%3],h-y);x=0
        while x<w:
            tw=min([1,23,11,47,14][tile%5],w-x)
            scissor(x,y,tw,th);original_draw(mode,start,count);finish();x+=tw;tile+=1
        y+=th;row+=1
    disable(0x0c11);bind_fbo(0x8ca8,fbo);bind_fbo(0x8ca9,0)
    blit(0,0,w,h,0,0,w,h,0x4000,0x2601);bind_fbo(0x8d40,0)

for args in [dict(filter_enabled=True,phi_min=18,phi_max=25,density=15),dict(filter_enabled=True,phi_min=24,axis=1,clip=38),dict(surface=True,filter_enabled=True,phi_min=18,phi_max=25,axis=3,clip=38)]:
    r.draw=original_draw;full,_=r.render(**args)
    for draw_tiles in [tiled_draw,variable_draw]:
        r.draw=draw_tiles;tiled,_=r.render(**args)
        assert np.array_equal(full,tiled),('Tile seams or lost edges',draw_tiles.__name__,np.max(abs(full-tiled)))
        print('PASS exact tiled output',draw_tiles.__name__,args,flush=True)
r.draw=original_draw
bg,_=r.render(density=0,edges=False)
assert np.array_equal(r.render(surface=True,filter_enabled=True,phi_min=100 if imported else 32,phi_max=100 if imported else 32)[0],bg)
assert np.array_equal(r.render(no_matches=True)[0],bg)
# Warm both paths before a like-for-like local work comparison (not browser FPS).
r.render(density=15);r.render(surface=True)
full_times=[r.render(density=15)[1] for _ in range(3)]
preview_times=[r.render(surface=True)[1] for _ in range(3)]
print('GLES comparison',{'pixels':w*h,'cells':meta['stats']['cells'],'full_volume_seconds':full_times,'surface_preview_seconds':preview_times},flush=True)
