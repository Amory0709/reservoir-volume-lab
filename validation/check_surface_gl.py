"""Production raster shaders vs the existing BVH ray surface, using real GLES."""
import check_explicit_gl as r
from check_explicit_gl import *
cache=Path(sys.argv[2])
use=gl('glUseProgram',None,[U]);create_program=gl('glCreateProgram',U,[])
def compile_program(vertex,fragment):
    p=create_program()
    for kind,src in [(0x8b31,vertex),(0x8b30,fragment)]:
        sh=create_shader(kind);s=c.c_char_p(src.encode());shader_source(sh,1,c.byref(s),None);compile_shader(sh)
        ok=I();shader_iv(sh,0x8b81,c.byref(ok));log=c.create_string_buffer(65536);shader_log(sh,len(log),None,log)
        assert ok.value,log.value.decode();attach(p,sh)
    gl('glLinkProgram',None,[U])(p);ok=I();gl('glGetProgramiv',None,[U,U,c.POINTER(I)])(p,0x8b82,c.byref(ok))
    if not ok.value:
        log=c.create_string_buffer(65536);gl('glGetProgramInfoLog',None,[U,I,c.POINTER(I),c.c_char_p])(p,len(log),None,log);raise AssertionError(log.value.decode())
    return p
surface_program=compile_program((cache/'surface-vertex.glsl').read_text(),(cache/'surface-fragment.glsl').read_text())
background_program=compile_program((root/'vertex.glsl').read_text(),(cache/'surface-background.glsl').read_text())
gen_fbo=gl('glGenFramebuffers',None,[I,c.POINTER(U)]);bind_fbo=gl('glBindFramebuffer',None,[U,U]);attach_fbo=gl('glFramebufferTexture2D',None,[U,U,U,U,I])
color=U();gen(1,c.byref(color));active(0x84c7);bind(0xde1,color)
for a,b in [(0x2801,0x2601),(0x2800,0x2601),(0x2802,0x812f),(0x2803,0x812f)]:param(0xde1,a,b)
tex2(0xde1,0,0x8058,w,h,0,0x1908,0x1401,None)
fbo=U();gen_fbo(1,c.byref(fbo));bind_fbo(0x8d40,fbo);attach_fbo(0x8d40,0x8ce0,0xde1,color,0)
depth=U();gl('glGenRenderbuffers',None,[I,c.POINTER(U)])(1,c.byref(depth));gl('glBindRenderbuffer',None,[U,U])(0x8d41,depth)
gl('glRenderbufferStorage',None,[U,U,I,I])(0x8d41,0x8cac,w,h);gl('glFramebufferRenderbuffer',None,[U,U,U,U])(0x8d40,0x8d00,0x8d41,depth)
assert gl('glCheckFramebufferStatus',U,[U])(0x8d40)==0x8cd5
surface_vao=U();gl('glGenVertexArrays',None,[I,c.POINTER(U)])(1,c.byref(surface_vao));bind_vao=gl('glBindVertexArray',None,[U]);bind_vao(surface_vao)
buf=U();gl('glGenBuffers',None,[I,c.POINTER(U)])(1,c.byref(buf));bind_buffer=gl('glBindBuffer',None,[U,U]);bind_buffer(0x8892,buf)
gl('glEnableVertexAttribArray',None,[U])(0);pointer=gl('glVertexAttribIPointer',None,[U,I,U,I,P]);pointer(0,1,0x1405,4,None);gl('glVertexAttribDivisor',None,[U,U])(0,1)
enable=gl('glEnable',None,[U]);disable=gl('glDisable',None,[U]);instances=gl('glDrawArraysInstanced',None,[U,I,I,I]);clear=gl('glClear',None,[U]);clear_depth=gl('glClearDepthf',None,[F]);depth_func=gl('glDepthFunc',None,[U])
def set_uniforms(p,s,basis,prop,edges):
    use(p)
    def at(n):return uniform(p,n.encode())
    u2(at('uResolution'),w,h);uf(at('uPixelRatio'),1);uf(at('uTanFov'),np.tan(np.deg2rad(21)));uf(at('uDensity'),28*.6**2);uf(at('uEdgeWidth'),1.2)
    for name,value in zip(['uEye','uForward','uRight','uUp'],basis):u3(at(name),*value)
    for name,value in [('uVertices',0),('uAttributes',1),('uColumnPillars',4),('uKInterfaces',5),('uImported',int(imported)),('uProperty',prop),('uEdges',int(edges)),('uPorosityFilter',int(s['porosityFilter'])),('uClipAxis',s['clipAxis'])]:ui(at(name),value)
    u3i(at('uDimensions'),*meta['dims']);u3i(at('uSplits'),*meta['splitsX']);u3(at('uBoundsMin'),*meta['bounds']['min']);u3(at('uBoundsMax'),*meta['bounds']['max'])
    u2(at('uPhi'),s['porosityMin']/100,s['porosityMax']/100)
    a=max(0,s['clipAxis']-1);lo=meta['bounds']['min'][a];hi=meta['bounds']['max'][a];uf(at('uClipPosition'),hi-(hi-lo)*s['clip']/100)
    if imported:
        info=meta['propertyInfo'][prop];u2(at('uPropertyRange'),info['min'],info['max']);ui(at('uPropertyLog'),int(info['log']))
def raster(name,s,basis,prop,edges,packed):
    codes=np.fromfile(cache/(name+('-packed' if packed else '')+'.bin'),np.uint32);bind_buffer(0x8892,buf);gl('glBufferData',None,[U,c.c_ssize_t,P,U])(0x8892,codes.nbytes,codes.ctypes.data,0x88e4)
    bind_fbo(0x8d40,fbo);disable(0x0b71);clear_depth(0);clear(0x0100)
    set_uniforms(background_program,s,basis,prop,edges);bind_vao(vao);draw(4,0,3)
    set_uniforms(surface_program,s,basis,prop,edges);bind_vao(surface_vao);enable(0x0b71);depth_func(0x0206)
    groups=json.loads((cache/(name+'-groups.json')).read_text()) if packed else [len(codes)]
    offset=0
    for group,count in enumerate(groups):
        is_packed=packed and group<6;ui(uniform(surface_program,b'uPacked'),int(is_packed));vertices=(group+1)*6 if is_packed else 6
        for off in range(0,count,1024):pointer(0,1,0x1405,4,c.c_void_p((offset+off)*4));instances(4,0,vertices,min(1024,count-off))
        offset+=count
    finish();pixels=np.zeros((h,w,4),np.uint8);read(0,0,w,h,0x1908,0x1401,pixels.ctypes.data);assert error()==0
    disable(0x0b71);bind_fbo(0x8d40,0);return pixels[:,:,:3].astype(float)
cases=json.loads((cache/'cases.json').read_text());checks=0
for az,el in [(-.87,.52),(2.3,.4),(-1.57,1.55),(-.8,-.6)]:
    for name,s in cases:
        for prop,edges in [(0,True),(1,False),(2,True)]:
            use(program);bind_vao(vao);bind_fbo(0x8d40,0);basis=r.camera(az,el)
            expected,_=r.render(surface=True,filter_enabled=s['porosityFilter'],phi_min=s['porosityMin'],phi_max=s['porosityMax'],axis=s['clipAxis'],clip=s['clip'],prop=prop,edges=edges)
            for packed in [False,True]:
                actual=raster(name,s,basis,prop,edges,packed);delta=abs(actual-expected)
                # Raster top-left coverage and the ray test may disagree exactly on
                # shared edges; they must not create missing shells or leaking caps.
                assert delta.mean()<.7 and (delta.max(axis=2)>12).mean()<.008,(name,az,el,prop,edges,packed,float(delta.mean()),int((delta.max(axis=2)>12).sum()))
                checks+=1
print('PASS production surface GLES vs BVH rays',{'comparisons':checks,'cells':meta['stats']['cells'],'imported':imported},flush=True)
