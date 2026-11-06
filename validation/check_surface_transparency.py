"""Real GLES MRT blending: opacity endpoints, lines and draw-order stability."""
from check_surface_gl import *

transparent_program=compile_program((cache/'surface-vertex.glsl').read_text(),(cache/'surface-transparent.glsl').read_text())
resolve_program=compile_program((root/'vertex.glsl').read_text(),(cache/'surface-resolve.glsl').read_text())
accum_fbo=U();gen_fbo(1,c.byref(accum_fbo));bind_fbo(0x8d40,accum_fbo)
accum_textures=[]
for slot,internal,fmt in [(0,0x881a,0x1908),(1,0x822d,0x1903)]:
    t=U();gen(1,c.byref(t));active(0x84c6+slot);bind(0xde1,t)
    for a,b in [(0x2801,0x2600),(0x2800,0x2600),(0x2802,0x812f),(0x2803,0x812f)]:param(0xde1,a,b)
    tex2(0xde1,0,internal,w,h,0,fmt,0x140b,None);attach_fbo(0x8d40,0x8ce0+slot,0xde1,t,0);accum_textures.append(t)
gl('glDrawBuffers',None,[I,c.POINTER(U)])(2,(U*2)(0x8ce0,0x8ce1))
assert gl('glCheckFramebufferStatus',U,[U])(0x8d40)==0x8cd5
blend_func=gl('glBlendFunc',None,[U,U]);blend_eq=gl('glBlendEquation',None,[U])
clear_buffer=gl('glClearBufferfv',None,[U,I,c.POINTER(F)])
def transparent(name,s,basis,opacity,edges=False,reverse=False):
    codes=np.fromfile(cache/(name+'-packed.bin'),np.uint32)
    groups=json.loads((cache/(name+'-groups.json')).read_text());offset=0;batches=[]
    for group,count in enumerate(groups):
        if reverse:codes[offset:offset+count]=codes[offset:offset+count][::-1]
        batches.append((offset,count,group));offset+=count
    if reverse:batches.reverse()
    bind_buffer(0x8892,buf);gl('glBufferData',None,[U,c.c_ssize_t,P,U])(0x8892,codes.nbytes,codes.ctypes.data,0x88e4)
    bind_fbo(0x8d40,accum_fbo);disable(0x0b71);enable(0x0be2);blend_eq(0x8006);blend_func(1,1)
    for index in [0,1]:clear_buffer(0x1800,index,(F*4)(0,0,0,0))
    set_uniforms(transparent_program,s,basis,0,edges);uf(uniform(transparent_program,b'uSurfaceOpacity'),opacity);bind_vao(surface_vao)
    for offset,count,group in batches:
        packed=group<6;ui(uniform(transparent_program,b'uPacked'),int(packed));vertices=(group+1)*6 if packed else 6
        for off in range(0,count,1024):pointer(0,1,0x1405,4,c.c_void_p((offset+off)*4));instances(4,0,vertices,min(1024,count-off))
    finish();assert error()==0,'Float blending failed'
    disable(0x0be2);bind_fbo(0x8d40,fbo);set_uniforms(resolve_program,s,basis,0,False)
    for slot,t in enumerate(accum_textures):active(0x84c6+slot);bind(0xde1,t)
    ui(uniform(resolve_program,b'uSurfaceAccum'),6);ui(uniform(resolve_program,b'uSurfaceDepth'),7)
    bind_vao(vao);draw(4,0,3);finish();pixels=np.zeros((h,w,4),np.uint8);read(0,0,w,h,0x1908,0x1401,pixels.ctypes.data);assert error()==0
    return pixels[:,:,:3].astype(float)

checks=0
for az,el in [(-.87,.52),(2.3,.4)]:
    use(program);basis=r.camera(az,el)
    empty=dict(cases[-1][1]);bg=raster('empty',empty,basis,0,False,True)
    for name,s in cases[:-1]:
        invisible=transparent(name,s,basis,0)
        assert np.max(abs(invisible-bg))<=1,(name,'Zero opacity is not clear')
        thin=transparent(name,s,basis,.25);thick=transparent(name,s,basis,.75)
        assert np.max(abs(thin-bg))>5,(name,'Missing translucent geometry')
        assert abs(thick-bg).sum()>abs(thin-bg).sum(),(name,'Opacity has no effect')
        wire=transparent(name,s,basis,0,True)
        assert np.max(abs(wire-bg))>5,(name,'Grid lines vanished with skin')
        for opacity,edges in [(.25,False),(.65,True)]:
            forward=transparent(name,s,basis,opacity,edges);backward=transparent(name,s,basis,opacity,edges,True)
            delta=abs(forward-backward)
            assert delta.mean()<.5 and delta.max()<=5,(name,'Draw-order artifacts',float(delta.mean()),float(delta.max()))
            checks+=1
print('PASS translucent surface GLES: opacity, wireframe, clipping, filters and reverse draw order',{'checks':checks,'imported':imported},flush=True)
