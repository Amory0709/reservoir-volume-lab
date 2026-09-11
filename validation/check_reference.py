"""Offscreen OpenGL ES numerical checks; no browser or screenshot capture."""
import ctypes as c
import json, time
from pathlib import Path
import numpy as np

import sys
root=Path(sys.argv[1])
E=c.CDLL('libEGL.so.1')
E.eglGetProcAddress.restype=c.c_void_p;E.eglGetProcAddress.argtypes=[c.c_char_p]
def egl(name,restype,args):
    f=getattr(E,name);f.restype=restype;f.argtypes=args;return f
def gl(name,restype,args):
    p=E.eglGetProcAddress(name.encode());assert p,name
    return c.CFUNCTYPE(restype,*args)(p)
P=c.c_void_p;I=c.c_int;U=c.c_uint;F=c.c_float
get=c.CFUNCTYPE(P,U,P,c.POINTER(I))(E.eglGetProcAddress(b'eglGetPlatformDisplayEXT'))
d=get(0x31dd,None,None);major=I();minor=I()
assert egl('eglInitialize',U,[P,c.POINTER(I),c.POINTER(I)])(d,c.byref(major),c.byref(minor))
assert egl('eglBindAPI',U,[U])(0x30a0)
attrs=(I*15)(0x3040,0x40,0x3033,1,0x3024,8,0x3023,8,0x3022,8,0x3021,8,0x3025,0,0x3038)
config=P();n=I();assert egl('eglChooseConfig',U,[P,c.POINTER(I),c.POINTER(P),I,c.POINTER(I)])(d,attrs,c.byref(config),1,c.byref(n)) and n.value
w,h=192,144
surface=egl('eglCreatePbufferSurface',P,[P,P,c.POINTER(I)])(d,config,(I*5)(0x3057,w,0x3056,h,0x3038))
context=egl('eglCreateContext',P,[P,P,P,c.POINTER(I)])(d,config,None,(I*3)(0x3098,3,0x3038))
assert surface and context
assert egl('eglMakeCurrent',U,[P,P,P,P])(d,surface,surface,context)
get_string=gl('glGetString',c.c_char_p,[U]);print('CONTEXT',get_string(0x1f02).decode(),flush=True)
create_shader=gl('glCreateShader',U,[U]);shader_source=gl('glShaderSource',None,[U,I,c.POINTER(c.c_char_p),c.POINTER(I)])
compile_shader=gl('glCompileShader',None,[U]);shader_iv=gl('glGetShaderiv',None,[U,U,c.POINTER(I)])
shader_log=gl('glGetShaderInfoLog',None,[U,I,c.POINTER(I),c.c_char_p])
shaders=[]
for kind,file in [(0x8b31,'vertex.glsl'),(0x8b30,'alpha.glsl')]:
    shader=create_shader(kind);src=c.c_char_p((root/file).read_bytes());shader_source(shader,1,c.byref(src),None);compile_shader(shader)
    ok=I();shader_iv(shader,0x8b81,c.byref(ok));log=c.create_string_buffer(65536);shader_log(shader,len(log),None,log)
    assert ok.value,(file,log.value.decode());shaders.append(shader)
program=gl('glCreateProgram',U,[])();attach=gl('glAttachShader',None,[U,U])
for shader in shaders:attach(program,shader)
gl('glLinkProgram',None,[U])(program);ok=I();gl('glGetProgramiv',None,[U,U,c.POINTER(I)])(program,0x8b82,c.byref(ok))
assert ok.value,'Link failed'
gl('glUseProgram',None,[U])(program)
uniform=gl('glGetUniformLocation',I,[U,c.c_char_p]);ui=gl('glUniform1i',None,[I,I]);uf=gl('glUniform1f',None,[I,F]);u2=gl('glUniform2f',None,[I,F,F]);u3=gl('glUniform3f',None,[I,F,F,F])
def loc(name):return uniform(program,name.encode())
meta=json.loads((root/'metadata.json').read_text())
gen=gl('glGenTextures',None,[I,c.POINTER(U)]);bind=gl('glBindTexture',None,[U,U]);active=gl('glActiveTexture',None,[U]);param=gl('glTexParameteri',None,[U,U,I]);tex2=gl('glTexImage2D',None,[U,I,I,I,I,I,U,U,P]);tex3=gl('glTexImage3D',None,[U,I,I,I,I,I,I,U,U,P])
u2i=gl('glUniform2i',None,[I,I,I]);u3i=gl('glUniform3i',None,[I,I,I,I]);error=gl('glGetError',U,[])
texture_ids=[]
for index,(name,key,dims,integer) in enumerate([('uAttributes','attributes',meta['dims'],True),('uBricks','bricks',meta['coarse'],True),('uAxes','axisData',[meta['axisWidth'],1],False),('uFold','foldData',[meta['foldWidth'],1],False)]):
    t=U();gen(1,c.byref(t));texture_ids.append(t);active(0x84c0+index);target=0x806f if integer else 0xde1;bind(target,t)
    for a,b in [(0x2801,0x2600),(0x2800,0x2600),(0x2802,0x812f),(0x2803,0x812f)]:param(target,a,b)
    if integer:param(target,0x8072,0x812f)
    data=np.fromfile(root/(key+'.bin'),dtype=np.uint8 if integer else np.float32)
    if integer:tex3(target,0,0x8d7c,*dims,0,0x8d99,0x1401,data.ctypes.data)
    else:tex2(target,0,0x8814,*dims,0,0x1908,0x1406,data.ctypes.data)
    assert error()==0,('Texture failed',key)
    ui(loc(name),index)
vao=U();gl('glGenVertexArrays',None,[I,c.POINTER(U)])(1,c.byref(vao));gl('glBindVertexArray',None,[U])(vao)
gl('glViewport',None,[I,I,I,I])(0,0,w,h)
u2(loc('uResolution'),w,h);uf(loc('uTanFov'),np.tan(np.deg2rad(21)));uf(loc('uPixelRatio'),1)
u3(loc('uBoundsMin'),*meta['bounds']['min']);u3(loc('uBoundsMax'),*meta['bounds']['max']);u3i(loc('uDimensions'),*meta['dims'])
def camera(az=-.87,el=.52,distance=10.2,target=(0,0,-.05)):
    eye=np.array([np.cos(el)*np.cos(az),np.cos(el)*np.sin(az),np.sin(el)])*distance+np.array(target)
    forward=np.array(target)-eye;forward/=np.linalg.norm(forward)
    right=np.cross(forward,[0,0,1]);right/=np.linalg.norm(right);up=np.cross(right,forward)
    for key,p in [('uEye',eye),('uForward',forward),('uRight',right),('uUp',up)]:u3(loc(key),*p)
    return eye,forward,right,up
camera()
draw=gl('glDrawArrays',None,[U,I,I]);finish=gl('glFinish',None,[]);read=gl('glReadPixels',None,[I,I,I,I,U,U,P])
def render(density=60,edges=True,axis=0,clip=0,prop=0,width=1.2,interior=True,filter_enabled=False,phi_min=8,phi_max=32,skip=True):
    ui(loc('uProperty'),prop);ui(loc('uEdges'),int(edges));ui(loc('uInterior'),int(interior));ui(loc('uClipAxis'),axis)
    ui(loc('uPorosityFilter'),int(filter_enabled));u2i(loc('uPhi'),int(np.ceil((phi_min-8)/24*255-1e-9)),int(np.floor((phi_max-8)/24*255+1e-9)))
    ui(loc('uSkipBricks'),int(skip));uf(loc('uDensity'),28*(density/100)**2);uf(loc('uEdgeWidth'),width)
    a=max(0,axis-1);lo=meta['bounds']['min'][a];hi=meta['bounds']['max'][a];uf(loc('uClipPosition'),hi-(hi-lo)*clip/100)
    start=time.monotonic();draw(4,0,3);finish();pixels=np.zeros((h,w,4),dtype=np.uint8);read(0,0,w,h,0x1908,0x1401,pixels.ctypes.data)
    assert error()==0
    return pixels[:,:,:3].astype(float),round(time.monotonic()-start,3)

from reference import reference_alpha
errors=[];tested=0
for az,el,options in [(-.87,.52,{}),(2.3,.4,{'filter_enabled':True,'phi_min':18,'phi_max':25}),(-.87,.52,{'filter_enabled':True,'phi_min':24,'axis':1,'clip':38}),(-1.57,1.57,{'axis':3,'clip':38})]:
    eye,forward,right,up=camera(az,el);pixels,_=render(density=15,edges=False,**options)
    rng=np.random.default_rng(238)
    for x,y in zip(rng.integers(w//5,w*4//5,64),rng.integers(h//5,h*4//5,64)):
        xy=(np.array([x+.5,y+.5])*2-np.array([w,h]))/h
        direction=forward+np.tan(np.deg2rad(21))*(xy[0]*right+xy[1]*up);direction/=np.linalg.norm(direction)
        expected=reference_alpha(eye,direction,density=15,phi_min=options.get('phi_min',8),phi_max=options.get('phi_max',32),clip_axis=options.get('axis',0),clip=options.get('clip',0))
        error_value=abs(pixels[y,x,0]-expected*255);errors.append(error_value);tested+=1
        assert error_value<1.2,(az,el,int(x),int(y),float(pixels[y,x,0]),expected*255,error_value)
print('PASS: independent all-brick/all-cell slab reference matches GPU optical integration across',tested,'rays; maximum 8-bit alpha error',max(errors),flush=True)
