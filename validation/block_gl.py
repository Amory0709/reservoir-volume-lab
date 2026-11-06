from check_explicit_gl import *

directory=Path(os.environ['BLOCK_INDEX'])
index=json.loads((directory/'index.json').read_text())
for unit,name,key,channels,internal,fmt,typ,dtype in [
    (6,'uBlockData','data',4,0x8814,0x1908,0x1406,np.float32),
    (7,'uBinRanges','ranges',2,0x823c,0x8228,0x1405,np.uint32),
    (8,'uBinLeaves','leaves',1,0x8236,0x8d94,0x1405,np.uint32)]:
    data=np.fromfile(directory/(key+'.bin'),dtype=dtype);width=512 if key=='data' else 2048
    t=U();gen(1,c.byref(t));active(0x84c0+unit);bind(0xde1,t)
    for a,b in [(0x2801,0x2600),(0x2800,0x2600),(0x2802,0x812f),(0x2803,0x812f)]:param(0xde1,a,b)
    tex2(0xde1,0,internal,width,data.size//(width*channels),0,fmt,typ,data.ctypes.data)
    assert error()==0,('Index texture',key);ui(loc(name),unit)
ui(loc('uBlockCount'),index['count']);ui(loc('uBlockTraversal'),int(os.environ.get('BLOCK_TRAVERSAL','1')))

# Mirror the production choice: use property-range BVH pruning for selective
# filters; uniform bins for the complete active volume.
base_render=render
phi_limits=np.fromfile(root/'ranges.bin',np.float32,count=2)
def render(*args,**kwargs):
    mode=int(os.environ.get('BLOCK_TRAVERSAL','1'))
    if os.environ.get('BLOCK_AUTO','1')=='1' and kwargs.get('filter_enabled',False):
        mode *= int(kwargs.get('phi_min',8)/100<=phi_limits[0] and kwargs.get('phi_max',32)/100>=phi_limits[1])
    ui(loc('uBlockTraversal'),mode)
    return base_render(*args,**kwargs)
