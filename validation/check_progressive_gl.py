"""GLES: production tile/patch coordinates, sharp base and exact final pixels."""
import check_explicit_gl as r
from check_explicit_gl import *
tiles=json.loads(Path(sys.argv[2]).read_text());sw,sh=tiles['width'],tiles['height']
assert (w,h)==(tiles['displayWidth'],tiles['displayHeight'])
gen_fbo=gl('glGenFramebuffers',None,[I,c.POINTER(U)]);bind_fbo=gl('glBindFramebuffer',None,[U,U]);attach_fbo=gl('glFramebufferTexture2D',None,[U,U,U,U,I])
blit=gl('glBlitFramebuffer',None,[I,I,I,I,I,I,I,I,U,U]);viewport=gl('glViewport',None,[I,I,I,I])
enable=gl('glEnable',None,[U]);disable=gl('glDisable',None,[U]);scissor=gl('glScissor',None,[I,I,I,I])
def target(width,height):
    texture=U();gen(1,c.byref(texture));active(0x84c7);bind(0xde1,texture)
    for a,b in [(0x2801,0x2601),(0x2800,0x2601),(0x2802,0x812f),(0x2803,0x812f)]:param(0xde1,a,b)
    tex2(0xde1,0,0x8058,width,height,0,0x1908,0x1401,None)
    f=U();gen_fbo(1,c.byref(f));bind_fbo(0x8d40,f);attach_fbo(0x8d40,0x8ce0,0xde1,texture,0)
    assert gl('glCheckFramebufferStatus',U,[U])(0x8d40)==0x8cd5
    return f
front=target(w,h);back=target(sw,sh);original_draw=r.draw;partial=[]
def pixels():
    bind_fbo(0x8d40,0);finish();out=np.zeros((h,w,4),np.uint8);read(0,0,w,h,0x1908,0x1401,out.ctypes.data);assert error()==0
    return out[:,:,:3].astype(float)
def show(source,width,height):
    bind_fbo(0x8ca8,source);bind_fbo(0x8ca9,0);blit(0,0,width,height,0,0,w,h,0x4000,0x2601);bind_fbo(0x8d40,0)
def draw_full(mode,start,count):
    bind_fbo(0x8d40,back);original_draw(mode,start,count);show(back,sw,sh)
def draw_progressive(mode,start,count):
    # Seed the back texture from the full-resolution shell, keeping the canvas
    # itself sharp until each completed region (plus filter halo) is available.
    show(front,w,h);before=pixels()
    bind_fbo(0x8ca8,front);bind_fbo(0x8ca9,back);blit(0,0,w,h,0,0,sw,sh,0x4000,0x2601)
    for tile in tiles['tiles']:
        bind_fbo(0x8d40,back);enable(0x0c11);scissor(tile['x'],tile['y'],tile['w'],tile['h']);original_draw(mode,start,count);finish()
        p=tile['patch'];bind_fbo(0x8ca8,back);bind_fbo(0x8ca9,0);scissor(p['x'],p['y'],p['w'],p['h'])
        blit(0,0,sw,sh,0,0,w,h,0x4000,0x2601);disable(0x0c11)
        after=pixels();outside=np.ones((h,w),bool);outside[p['y']:p['y']+p['h'],p['x']:p['x']+p['w']]=False
        assert np.array_equal(before[outside],after[outside]),'Unfinished sharp surface was overwritten'
        partial.append(after);before=after
    # Test the tiled composition BEFORE any final full-frame copy could mask a seam.
checks=0
for light in [0,1]:
    ui(loc('uLightMode'),light)
    for axis in [0,1,2,3]:
        args=dict(filter_enabled=True,phi_min=18,phi_max=25,density=15,axis=axis,clip=38,edges=True)
        # Render a real opaque shell into the retained front framebuffer.
        u2(loc('uResolution'),w,h);viewport(0,0,w,h)
        def draw_shell(mode,start,count):
            bind_fbo(0x8d40,front);original_draw(mode,start,count);show(front,w,h)
        r.draw=draw_shell;base,_=r.render(surface=True,**args)
        u2(loc('uResolution'),sw,sh);viewport(0,0,sw,sh)
        r.draw=draw_full;expected,_=r.render(**args)
        partial.clear();r.draw=draw_progressive;actual,_=r.render(**args)
        assert np.array_equal(expected,actual),('Progressive seams/lost grid lines',light,axis,np.max(abs(expected-actual)))
        assert any(np.max(abs(p-base))>2 for p in partial[:-1]),'No volume appeared before completion'
        checks+=1
print('PASS progressive GLES: unchanged unfinished surface, early volume, seamless final image, light/dark, filters and XYZ cuts',{'checks':checks,'imported':imported},flush=True)
