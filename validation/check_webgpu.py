"""Execute production WGSL with wgpu-native; compare to GLES, not browser performance."""
import sys,json,pathlib,time
import numpy as np
import wgpu
root=pathlib.Path(sys.argv[1]);out=pathlib.Path(sys.argv[2]);meta=json.loads((root/'metadata.json').read_text())
adapter=wgpu.gpu.request_adapter_sync(power_preference='high-performance');device=adapter.request_device_sync()
print('Adapter',adapter.info,flush=True)
# Translate only WebGPU dictionary spelling; bindings and shader source come from JS.
def snake(key):
 import re
 return re.sub(r'(?<!^)(?=[A-Z])','_',key).lower()
def translate(value):
 if isinstance(value,dict):return {snake(k):translate(v) for k,v in value.items()}
 if isinstance(value,list):return [translate(v) for v in value]
 return value
layout=device.create_bind_group_layout(entries=translate(json.loads((out/'grid-layout.json').read_text())))
frame=device.create_buffer(size=224,usage=wgpu.BufferUsage.UNIFORM|wgpu.BufferUsage.COPY_DST)
entries=[{'binding':0,'resource':{'buffer':frame}}];textures=[]
imported=meta.get('synthetic',True) is False
for i,(key,dims,fmt,bpp) in enumerate([
 ('vertices',meta['nodeDims'],'rgba32float',16),('attributes',meta['dims'],'rgba32float',16),
 ('nodes',[meta['nodeWidth'],meta['nodeHeight']],'rgba32float',16),('ranges',[meta['nodeWidth'],meta['rangeHeight']],'rg32float',8),
 ('columnPillars',meta['dims'][:2] if imported else [1,1],'rgba32uint',16),('kInterfaces',[meta['dims'][2],1] if imported else [1,1],'rg32uint',8)]):
 size=tuple(dims+[1]*(3-len(dims)));texture=device.create_texture(size=size,dimension='3d' if len(dims)==3 else '2d',format=fmt,usage=wgpu.TextureUsage.TEXTURE_BINDING|wgpu.TextureUsage.COPY_DST)
 data=(root/(key+'.bin')).read_bytes() if i<4 or imported else bytes(bpp)
 device.queue.write_texture({'texture':texture},data,{'bytes_per_row':dims[0]*bpp,'rows_per_image':dims[1]},size)
 textures.append(texture);entries.append({'binding':i+1,'resource':texture.create_view()})
group=device.create_bind_group(layout=layout,entries=entries)
output_layout=device.create_bind_group_layout(entries=[{'binding':0,'visibility':wgpu.ShaderStage.COMPUTE,'storage_texture':{'access':'write-only','format':'rgba8unorm'}}])
compute=device.create_compute_pipeline(layout=device.create_pipeline_layout(bind_group_layouts=[layout,output_layout]),compute={'module':device.create_shader_module(code=(out/'webgpuComputeShader.wgsl').read_text()),'entry_point':'computeMain'})
result=device.create_texture(size=(96,72,1),format='rgba8unorm',usage=wgpu.TextureUsage.STORAGE_BINDING|wgpu.TextureUsage.COPY_SRC|wgpu.TextureUsage.RENDER_ATTACHMENT|wgpu.TextureUsage.TEXTURE_BINDING)
output=device.create_bind_group(layout=output_layout,entries=[{'binding':0,'resource':result.create_view()}])
cases=json.loads((out/'cases.json').read_text());maximum=0;worstmean=0
for case in cases:
 device.queue.write_buffer(frame,0,(out/f"frame-{case['index']}.bin").read_bytes());encoder=device.create_command_encoder();p=encoder.begin_compute_pass();p.set_pipeline(compute);p.set_bind_group(0,group);p.set_bind_group(1,output);p.dispatch_workgroups(12,9);p.end();device.queue.submit([encoder.finish()])
 pixels=np.frombuffer(device.queue.read_texture({'texture':result},{'bytes_per_row':384,'rows_per_image':72},(96,72,1)),np.uint8).reshape(72,96,4)[:,:,:3]
 ref=np.load(out/f"reference-{case['index']}.npy");delta=np.abs(pixels.astype(float)-ref)
 maximum=max(maximum,float(delta.max()));worstmean=max(worstmean,float(delta.mean()))
 # Allow rare float traversal ties and quantization; broad loss of edges/filtering fails.
 assert delta.mean()<.5 and np.mean(np.max(delta,axis=2)>8)<.003,(case,float(delta.max()),float(delta.mean()))
print('PASS compute',len(cases),'cases; max channel delta',maximum,'worst mean delta',worstmean,flush=True)
# Validate all render pipelines, including cap vertices and float additive blending.
surface=device.create_shader_module(code=(out/'webgpuSurfaceShader.wgsl').read_text());surface_layout=device.create_pipeline_layout(bind_group_layouts=[layout]);pipelines={}
for transparent in [False,True]:
 for packed in [False,True]:
  blend={'color':{'src_factor':'one','dst_factor':'one','operation':'add'},'alpha':{'src_factor':'one','dst_factor':'one','operation':'add'}}
  desc=dict(layout=surface_layout,vertex={'module':surface,'entry_point':'packedVertex' if packed else 'capVertex','buffers':[{'array_stride':4,'step_mode':'instance','attributes':[{'shader_location':0,'offset':0,'format':'uint32'}]}]},fragment={'module':surface,'entry_point':'transparentFragment' if transparent else 'opaqueFragment','targets':[{'format':'rgba16float','blend':blend},{'format':'r16float','blend':blend}] if transparent else [{'format':'rgba8unorm'}]},primitive={'topology':'triangle-list','cull_mode':'none'})
  if not transparent:desc['depth_stencil']={'format':'depth32float','depth_write_enabled':True,'depth_compare':'greater-equal'}
  pipelines[(transparent,packed)]=device.create_render_pipeline(**desc)
background=device.create_render_pipeline(layout=surface_layout,vertex={'module':surface,'entry_point':'fullscreen'},fragment={'module':surface,'entry_point':'backgroundFragment','targets':[{'format':'rgba8unorm'}]})
resolve_layout=device.create_bind_group_layout(entries=[{'binding':i,'visibility':wgpu.ShaderStage.FRAGMENT,'texture':{'sample_type':'unfilterable-float'}} for i in range(2)])
resolve=device.create_render_pipeline(layout=device.create_pipeline_layout(bind_group_layouts=[layout,resolve_layout]),vertex={'module':surface,'entry_point':'fullscreen'},fragment={'module':surface,'entry_point':'resolveFragment','targets':[{'format':'rgba8unorm'}]})
present=device.create_shader_module(code=(out/'webgpuPresentShader.wgsl').read_text());present_pipeline=device.create_render_pipeline(layout='auto',vertex={'module':present,'entry_point':'fullscreen'},fragment={'module':present,'entry_point':'presentFragment','targets':[{'format':'rgba8unorm'}]})
print('PASS surface, OIT resolve and presentation pipelines',flush=True)
if len(sys.argv)>3:
 cache=pathlib.Path(sys.argv[3]);surface_cases=json.loads((out/'surface-cases.json').read_text())
 depth=device.create_texture(size=(96,72,1),format='depth32float',usage=wgpu.TextureUsage.RENDER_ATTACHMENT)
 def attachment(texture,load='load'):return {'view':texture.create_view(),'load_op':load,'store_op':'store','clear_value':(0,0,0,0)}
 def read_result():return np.frombuffer(device.queue.read_texture({'texture':result},{'bytes_per_row':384,'rows_per_image':72},(96,72,1)),np.uint8).reshape(72,96,4)[:,:,:3].astype(float)
 max_mean=0
 for case in surface_cases:
  codes=(cache/(case['name']+'-packed.bin')).read_bytes();groups=json.loads((cache/(case['name']+'-groups.json')).read_text())
  buf=device.create_buffer_with_data(data=codes or bytes(4),usage=wgpu.BufferUsage.VERTEX)
  device.queue.write_buffer(frame,0,(out/f"surface-frame-{case['index']}.bin").read_bytes())
  encoder=device.create_command_encoder();p=encoder.begin_render_pass(color_attachments=[attachment(result,'clear')]);p.set_pipeline(background);p.set_bind_group(0,group);p.draw(3);p.end()
  p=encoder.begin_render_pass(color_attachments=[attachment(result)],depth_stencil_attachment={'view':depth.create_view(),'depth_load_op':'clear','depth_store_op':'store','depth_clear_value':0})
  p.set_bind_group(0,group);p.set_vertex_buffer(0,buf);offset=0
  for i,count in enumerate(groups):
   p.set_pipeline(pipelines[(False,i<6)]);p.draw((i+1)*6 if i<6 else 6,count,0,offset);offset+=count
  p.end();device.queue.submit([encoder.finish()]);actual=read_result();buf.destroy()
  expected=np.load(out/f"surface-reference-{case['index']}.npy");delta=abs(actual-expected);max_mean=max(max_mean,float(delta.mean()))
  assert delta.mean()<.7 and np.mean(np.max(delta,axis=2)>12)<.008,(case,float(delta.mean()),int((delta.max(axis=2)>12).sum()))
 print('PASS raster vs GLES ray surface',len(surface_cases),'cases; worst mean delta',max_mean,flush=True)
 # Exercise transparency endpoints, retained wireframe, and draw order with real MRT.
 accum=[device.create_texture(size=(96,72,1),format=fmt,usage=wgpu.TextureUsage.RENDER_ATTACHMENT|wgpu.TextureUsage.TEXTURE_BINDING) for fmt in ['rgba16float','r16float']]
 resolve_group=device.create_bind_group(layout=resolve_layout,entries=[{'binding':i,'resource':t.create_view()} for i,t in enumerate(accum)])
 def oit(case,opacity,edges,reverse=False):
  raw=bytearray((out/f"surface-frame-{case['index']}.bin").read_bytes());floats=np.frombuffer(raw,np.float32);uints=np.frombuffer(raw,np.uint32);floats[23]=opacity;uints[38]=int(edges);device.queue.write_buffer(frame,0,raw)
  codes=np.fromfile(cache/(case['name']+'-packed.bin'),np.uint32);groups=json.loads((cache/(case['name']+'-groups.json')).read_text());offset=0;batches=[]
  for i,count in enumerate(groups):
   if reverse:codes[offset:offset+count]=codes[offset:offset+count][::-1]
   batches.append((i,count,offset));offset+=count
  if reverse:batches.reverse()
  buf=device.create_buffer_with_data(data=codes if codes.size else bytes(4),usage=wgpu.BufferUsage.VERTEX)
  encoder=device.create_command_encoder();p=encoder.begin_render_pass(color_attachments=[attachment(t,'clear') for t in accum]);p.set_bind_group(0,group);p.set_vertex_buffer(0,buf)
  for i,count,offset in batches:p.set_pipeline(pipelines[(True,i<6)]);p.draw((i+1)*6 if i<6 else 6,count,0,offset)
  p.end();p=encoder.begin_render_pass(color_attachments=[attachment(result,'clear')]);p.set_pipeline(resolve);p.set_bind_group(0,group);p.set_bind_group(1,resolve_group);p.draw(3);p.end();device.queue.submit([encoder.finish()]);image=read_result();buf.destroy();return image
 checks=0
 for case in surface_cases:
  if case['settings']['property']!=0 or case['name']=='empty':continue
  raw=bytearray((out/f"surface-frame-{case['index']}.bin").read_bytes());device.queue.write_buffer(frame,0,raw)
  encoder=device.create_command_encoder();p=encoder.begin_render_pass(color_attachments=[attachment(result,'clear')]);p.set_pipeline(background);p.set_bind_group(0,group);p.draw(3);p.end();device.queue.submit([encoder.finish()]);bg=read_result()
  zero=oit(case,0,False);assert np.max(abs(zero-bg))<=1,('Zero opacity',case)
  wire=oit(case,0,True);assert np.max(abs(wire-bg))>5,('Lines missing',case)
  thin=oit(case,.25,False);thick=oit(case,.75,False);assert abs(thick-bg).sum()>abs(thin-bg).sum(),('Opacity not applied',case)
  forward=oit(case,.65,True);backward=oit(case,.65,True,True);delta=abs(forward-backward)
  assert delta.mean()<.5 and delta.max()<=5,('Order artifacts',case,float(delta.mean()),float(delta.max()))
  checks+=1
 print('PASS real WebGPU MRT transparency, wireframe and draw order',checks,'cases',flush=True)
 # Presentation sampling must preserve orientation and exact pixel centers.
 before=read_result();display=device.create_texture(size=(96,72,1),format='rgba8unorm',usage=wgpu.TextureUsage.RENDER_ATTACHMENT|wgpu.TextureUsage.COPY_SRC)
 sampler=device.create_sampler(min_filter='linear',mag_filter='linear');pg=device.create_bind_group(layout=present_pipeline.get_bind_group_layout(0),entries=[{'binding':0,'resource':result.create_view()},{'binding':1,'resource':sampler}])
 encoder=device.create_command_encoder();p=encoder.begin_render_pass(color_attachments=[attachment(display,'clear')]);p.set_pipeline(present_pipeline);p.set_bind_group(0,pg);p.draw(3);p.end();device.queue.submit([encoder.finish()])
 after=np.frombuffer(device.queue.read_texture({'texture':display},{'bytes_per_row':384,'rows_per_image':72},(96,72,1)),np.uint8).reshape(72,96,4)[:,:,:3]
 assert np.max(abs(before-after))<=1,'Presentation flipped or changed pixels'
 print('PASS final presentation orientation',flush=True)
