"""Numerical GLES validation, not browser/UI QA. Full-size textures are uploaded."""
from offscreen_context import *
for index,(name,key,dims,channels) in enumerate([
    ('uVertices','vertices',meta['nodeDims'],4),('uAttributes','attributes',meta['dims'],4),
    ('uNodes','nodes',[meta['nodeWidth'],meta['nodeHeight']],4),('uRanges','ranges',[meta['nodeWidth'],meta['rangeHeight']],2)]):
    t=U();gen(1,c.byref(t));active(0x84c0+index);target=0x806f if len(dims)==3 else 0xde1;bind(target,t)
    for a,b in [(0x2801,0x2600),(0x2800,0x2600),(0x2802,0x812f),(0x2803,0x812f)]:param(target,a,b)
    data=np.fromfile(root/(key+'.bin'),dtype=np.float32)
    assert data.size==int(np.prod(dims))*channels,('Truncated binary input',key,data.size,dims)
    if len(dims)==3:
        param(target,0x8072,0x812f);tex3(target,0,0x8814,*dims,0,0x1908,0x1406,data.ctypes.data)
    else:tex2(target,0,0x8814 if channels==4 else 0x8230,*dims,0,0x1908 if channels==4 else 0x8227,0x1406,data.ctypes.data)
    assert error()==0,('Texture failed',key);ui(loc(name),index)
del data
imported=meta.get('synthetic',True) is False
for index,name,key,dims,channels in [(4,'uColumnPillars','columnPillars',meta['dims'][:2] if imported else [1,1],4),(5,'uKInterfaces','kInterfaces',[meta['dims'][2],1] if imported else [1,1],2)]:
    t=U();gen(1,c.byref(t));active(0x84c0+index);bind(0xde1,t)
    for a,b in [(0x2801,0x2600),(0x2800,0x2600),(0x2802,0x812f),(0x2803,0x812f)]:param(0xde1,a,b)
    data=np.fromfile(root/(key+'.bin'),np.uint32) if imported else np.zeros(channels,dtype=np.uint32)
    assert data.size==int(np.prod(dims))*channels
    tex2(0xde1,0,0x8d70 if channels==4 else 0x823c,*dims,0,0x8d99 if channels==4 else 0x8228,0x1405,data.ctypes.data)
    assert error()==0;ui(loc(name),index)
ui(loc('uImported'),int(imported))
vao=U();gl('glGenVertexArrays',None,[I,c.POINTER(U)])(1,c.byref(vao));gl('glBindVertexArray',None,[U])(vao)
gl('glViewport',None,[I,I,I,I])(0,0,w,h)
u2(loc('uResolution'),w,h);uf(loc('uTanFov'),np.tan(np.deg2rad(21)));uf(loc('uPixelRatio'),1)
u3(loc('uBoundsMin'),*meta['bounds']['min']);u3(loc('uBoundsMax'),*meta['bounds']['max']);u3i(loc('uDimensions'),*meta['dims']);u3i(loc('uSplits'),*meta['splitsX'])
for key,value in [('uNodeWidth',meta['nodeWidth']),('uNodeCount',meta['nodeCount']),('uCellCount',meta['stats']['cells'])]:ui(loc(key),value)
def camera(az=-.87,el=.52,distance=10.2,target=(0,0,-.05)):
    eye=np.array([np.cos(el)*np.cos(az),np.cos(el)*np.sin(az),np.sin(el)])*distance+np.array(target)
    forward=np.array(target)-eye;forward/=np.linalg.norm(forward)
    right=np.cross(forward,[0,0,1]);right/=np.linalg.norm(right);up=np.cross(right,forward)
    for key,p in [('uEye',eye),('uForward',forward),('uRight',right),('uUp',up)]:u3(loc(key),*p)
    return eye,forward,right,up
camera()
draw=gl('glDrawArrays',None,[U,I,I]);finish=gl('glFinish',None,[]);read=gl('glReadPixels',None,[I,I,I,I,U,U,P])
def render(density=60,edges=True,axis=0,clip=0,prop=0,width=1.2,interior=True,filter_enabled=False,phi_min=8,phi_max=32,skip=True,surface=False,no_matches=False):
    if imported:
        info=meta['propertyInfo'][prop];u2(loc('uPropertyRange'),info['min'],info['max']);ui(loc('uPropertyLog'),int(info['log']))
    ui(loc('uFastConnections'),int(os.environ.get('FAST_CONNECTIONS','1')));
    ui(loc('uSurfacePreview'),int(surface));ui(loc('uNoMatches'),int(no_matches));
    ui(loc('uProperty'),prop);ui(loc('uEdges'),int(edges));ui(loc('uInterior'),int(interior));ui(loc('uClipAxis'),axis)
    ui(loc('uPorosityFilter'),int(filter_enabled));u2(loc('uPhi'),phi_min/100,phi_max/100);ui(loc('uSkipBricks'),int(skip))
    uf(loc('uDensity'),28*(density/100)**2);uf(loc('uEdgeWidth'),width)
    a=max(0,axis-1);lo=meta['bounds']['min'][a];hi=meta['bounds']['max'][a];uf(loc('uClipPosition'),hi-(hi-lo)*clip/100)
    start=time.monotonic();draw(4,0,3);finish();pixels=np.zeros((h,w,4),dtype=np.uint8);read(0,0,w,h,0x1908,0x1401,pixels.ctypes.data)
    assert error()==0;return pixels[:,:,:3].astype(float),round(time.monotonic()-start,3)
if __name__=='__main__':
    base,_=render(0,False);results={}
    for name,args in [('solid',{}),('no_edges',{'edges':False}),('transparent',{'density':15}),('cut_x',{'axis':1,'clip':38}),('cut_y',{'axis':2,'clip':38}),('cut_z',{'axis':3,'clip':38}),('porosity',{'prop':1}),('permeability',{'prop':2}),('filtered',{'filter_enabled':True,'phi_min':24}),('filtered_cut',{'filter_enabled':True,'phi_min':24,'axis':1,'clip':38})]:
        pixels,secs=render(**args);results[name]=pixels;changed=np.max(abs(pixels-base),axis=2)>8
        assert changed.sum()>30,(name,'Missing volume');print(name,{'volume_pixels':int(changed.sum()),'software_seconds':secs},flush=True)
    assert np.count_nonzero(np.max(abs(results['solid']-results['no_edges']),axis=2)>2)>30,'No grid lines'
    assert np.array_equal(render(filter_enabled=True)[0],results['solid']),'Full range changes output'
    assert np.array_equal(render(filter_enabled=True,phi_min=32)[0],base),'Excluded cells leak volume or edges'
    for args in [{'filter_enabled':True,'phi_min':24},{'filter_enabled':True,'phi_min':18,'phi_max':25,'density':15},{'filter_enabled':True,'phi_min':24,'axis':1,'clip':38}]:
        a,_=render(**args);b,_=render(skip=False,**args);delta=np.max(abs(a-b),axis=2)
        assert delta.max()==0,('BVH range skipping lost pixels',float(delta.max()))
    for name,az,el in [('reverse',2.3,.4),('top',-1.57,1.57),('below',-.8,-.6)]:
        camera(az,el);bg,_=render(0,False);pixels,secs=render(filter_enabled=True,phi_min=18,phi_max=25)
        count=int((np.max(abs(pixels-bg),axis=2)>8).sum());assert count>30,(name,'No volume');print(name,count,secs,flush=True)
    camera(distance=.7,target=(.6,0,.55));near,_=render();plain,_=render(edges=False)
    assert np.count_nonzero(np.max(abs(near-plain),axis=2)>4)>30,'Zoomed grid edges missing'
    print('PASS explicit geometry',meta['stats'],flush=True)
