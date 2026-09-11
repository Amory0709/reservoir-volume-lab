"""Independent RESQML writer/reader fixture using bp's resqpy (5.2.0).
Usage: PYTHONPATH=<resqpy installation> python validation/make_resqml_fixtures.py <scratch-dir>
Generated EPC/HDF5 arrays are temporary test inputs, not customer data.
"""
import sys,json
from pathlib import Path
import numpy as np
import resqpy.model as rm
import resqpy.crs as rc
import resqpy.grid as rg
from resqpy.rq_import import grid_from_cp
from resqpy.property import Property

out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
epc=out/'reference.epc';model=rm.new_model(str(epc));crs=rc.Crs(model,xy_units='ft',z_units='ft',z_inc_down=True);crs.create_xml()
saved=[]
for variant in ['explicit','parametric','lattice']:
    shape=(3,3,5);nk,nj,ni=shape
    active=np.ones(shape,dtype=np.int32);active.flat[0]=0
    if variant=='lattice':
        grid=rg.RegularGrid(model,extent_kji=shape,dxyz=(20,25,4),crs_uuid=crs.uuid,title=variant)
        grid.create_xml()
    else:
        cp=np.zeros(shape+(2,2,2,3))
        for k in range(nk):
            for j in range(nj):
                for i in range(ni):
                    for kp in range(2):
                        for jp in range(2):
                            for ip in range(2):
                                x=i+ip;y=j+jp
                                cp[k,j,i,kp,jp,ip]=[600000+x*20+np.sin(y),5500000+y*25+.1*x,2000+(k+kp)*4+x*.4+np.sin(y)*.2+(8 if i>=2 else 0)+(2 if k>=1 else 0)]
        grid=grid_from_cp(model,cp,crs.uuid,active_mask=active.astype(bool),split_tolerance=.001,known_to_be_straight=True)
        grid.title=variant
        grid.write_hdf5_from_caches(mode='a',write_active=False,use_parametric_lines=variant=='parametric')
        grid.create_xml(title=variant,use_parametric_lines=variant=='parametric')
    phi=np.linspace(4,42,np.prod(shape)).reshape(shape);phi.flat[3]=np.nan
    so=np.linspace(.05,.85,np.prod(shape)).reshape(shape)
    perm=np.geomspace(.5,1500,np.prod(shape)).reshape(shape)
    ids={}
    for key,arr,pk,uom,discrete in [('phi',phi,'porosity','%',False),('so',so,'saturation','m3/m3',False),('k',perm,'rock permeability','mD',False),('active',active,'active',None,True)]:
        prop=Property.from_array(model,arr,source_info='independent resqpy fixture',keyword=key,support_uuid=grid.uuid,property_kind=pk,uom=uom,discrete=discrete,indexable_element='cells',compression='gzip',chunks='auto')
        ids[key]=str(prop.uuid)
    saved.append({'variant':variant,'grid':str(grid.uuid),'properties':ids,'phi':[None if not np.isfinite(x) else float(x)/100 for x in phi.flat],'active':active.reshape(-1).tolist()})
model.store_epc()
reopened=rm.Model(str(epc))
for item in saved:
    grid=rg.any_grid(reopened,uuid=item['grid']);grid.cache_all_geometry_arrays();cp=grid.corner_points(cache_cp_array=True)
    item['corners']=cp.reshape(-1,2,2,2,3).tolist();item['dims']=[int(grid.ni),int(grid.nj),int(grid.nk)]
    item['splitCount']=int(grid.split_pillars_count or 0);item['gapCount']=int(grid.k_gaps or 0)
(out/'expected.json').write_text(json.dumps(saved,allow_nan=False))
print('Wrote independent EPC/HDF5 fixtures:',[(x['variant'],x['dims'],x['splitCount'],x['gapCount']) for x in saved],flush=True)
