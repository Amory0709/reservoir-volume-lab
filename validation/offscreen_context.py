"""Offscreen OpenGL ES numerical checks; no browser or screenshot capture."""
import ctypes as c
import json, time
from pathlib import Path
import numpy as np

import sys, os
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
w,h=96,72
surface=egl('eglCreatePbufferSurface',P,[P,P,c.POINTER(I)])(d,config,(I*5)(0x3057,w,0x3056,h,0x3038))
context=egl('eglCreateContext',P,[P,P,P,c.POINTER(I)])(d,config,None,(I*3)(0x3098,3,0x3038))
assert surface and context
assert egl('eglMakeCurrent',U,[P,P,P,P])(d,surface,surface,context)
get_string=gl('glGetString',c.c_char_p,[U]);print('CONTEXT',get_string(0x1f02).decode(),flush=True)
create_shader=gl('glCreateShader',U,[U]);shader_source=gl('glShaderSource',None,[U,I,c.POINTER(c.c_char_p),c.POINTER(I)])
compile_shader=gl('glCompileShader',None,[U]);shader_iv=gl('glGetShaderiv',None,[U,U,c.POINTER(I)])
shader_log=gl('glGetShaderInfoLog',None,[U,I,c.POINTER(I),c.c_char_p])
shaders=[]
for kind,file in [(0x8b31,'vertex.glsl'),(0x8b30,'fragment.glsl')]:
    shader=create_shader(kind);src=c.c_char_p((root/(os.environ.get('EXPLICIT_FRAGMENT', 'alpha.glsl' if os.environ.get('EXPLICIT_ALPHA') else file) if file=='fragment.glsl' else file)).read_bytes());shader_source(shader,1,c.byref(src),None);compile_shader(shader)
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
