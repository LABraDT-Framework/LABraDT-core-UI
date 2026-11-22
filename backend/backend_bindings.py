"""Durable server-side bindings, frozen per business run; never browser-driven."""
from __future__ import annotations
import asyncio
import copy
import hashlib
import json
import math
import os
import re
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from fastapi import HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from . import aas_proxy as aas
from . import gateway_proxy as gateway
from . import repository_proxy as repository

DIRECTIONS = {'gateway_to_aas', 'aas_to_gateway', 'bidirectional'}
TYPES = {'xs:string','xs:boolean','xs:double','xs:float','xs:int','xs:long'}
def unpack(response): return json.loads(response.body)
def fingerprint(value): return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
def typed(value, kind):
    if kind not in TYPES: raise HTTPException(400, 'Unsupported binding valueType')
    if kind == 'xs:string': return str(value)
    if kind == 'xs:boolean':
        if str(value).lower() not in {'true','false','1','0'}: raise HTTPException(400,'Invalid boolean')
        return str(value).lower() in {'true','1'}
    if isinstance(value,bool): raise HTTPException(400,'Boolean is not a number')
    try:
        if kind in {'xs:int','xs:long'}:
            if not re.fullmatch(r'-?\d+',str(value)): raise ValueError()
            number=int(value); bits=32 if kind=='xs:int' else 64
            if not -(2**(bits-1)) <= number < 2**(bits-1): raise ValueError()
            return number
        number=float(value)
        if not math.isfinite(number): raise ValueError()
        return number
    except (ValueError,TypeError,OverflowError) as error: raise HTTPException(400,'Invalid or out-of-range numeric value') from error

def direction(binding, baseline, gv, av):
    if binding['direction'] != 'bidirectional': return binding['direction']
    if baseline is None:
        if gv == av: return 'none'
        return {'gateway':'gateway_to_aas','aas':'aas_to_gateway'}.get(binding['startupAuthority'],'conflict')
    gc,ac=gv!=baseline[0],av!=baseline[1]
    if gc and ac: return 'none' if gv==av else 'conflict'
    return 'gateway_to_aas' if gc else 'aas_to_gateway' if ac else 'none'

class Store:
    def __init__(self,path): self.path=Path(path);self.lock=threading.RLock()
    def read(self):
        with self.lock:
            if not self.path.exists(): return {'revision':0,'bindings':[],'runSnapshot':None,'events':[]}
            try:
                data=json.loads(self.path.read_text(encoding='utf-8'))
                if not isinstance(data.get('bindings'),list) or not isinstance(data.get('events'),list) or type(data.get('revision')) is not int: raise ValueError()
                return data
            except (ValueError,OSError) as error: raise HTTPException(503,'Backend configuration store is corrupt/unreadable; preserve the file and restore a backup') from error
    def write(self,data):
        with self.lock:
            self.path.parent.mkdir(parents=True,exist_ok=True)
            name=None
            try:
                with tempfile.NamedTemporaryFile(mode='w',encoding='utf-8',dir=self.path.parent,delete=False) as output:
                    name=output.name;json.dump(data,output,ensure_ascii=False,allow_nan=False);output.flush();os.fsync(output.fileno())
                os.replace(name,self.path);name=None
            finally:
                if name: os.unlink(name)

class BackendBindings:
    def __init__(self,store,base,health_url,directory,probe=None):
        self.store=store;self.base=base;self.gateway=gateway.gateway_base(health_url);self.directory=Path(directory);self.probe=probe
        self.states={};self.baselines={};self.next_due={};self.cursor=0;self.worker_error='';self.run_id=''
        self.rules_getter=None
    def catalog(self):
        signals=[]
        for path in sorted(self.directory.glob('*.json')):
            config=json.loads(path.read_text(encoding='utf-8'))
            for mapping in config.get('mappings',[]):
                signals.append({'key':config['machineId']+'.'+mapping['idShort'],'valueType':mapping['valueType'],
                    'protocol':config['protocol'],'endpoint':config['connection']['endpoint'],'sourceAddress':mapping['sourceAddress'],
                    'writable':False if config['protocol']!='OPC_UA' else None,'config':config})
        properties=[]
        def walk(elements,sm,prefix=''):
            for element in elements:
                path=prefix+element.get('idShort','')
                if element.get('modelType')=='SubmodelElementCollection': walk(element.get('value',[]),sm,path+'.')
                if element.get('modelType')=='Property' and element.get('valueType') in TYPES:
                    properties.append({'submodelId':sm['id'],'path':path,'valueType':element['valueType'],'label':sm.get('idShort',sm['id'])+' / '+path})
        for sm in repository.models(self.base,'submodels'):  # the engine AASX while the repository is down
            if sm.get('idShort') not in repository.RESERVED | {'Behavior'}: walk(sm.get('submodelElements',[]),sm)
        # Credentials are only used server-side, never returned by the public catalog.
        return {'signals':signals,'properties':properties}
    def public_catalog(self):
        catalog=self.catalog()
        catalog['signals']=[{key:value for key,value in signal.items() if key!='config'} for signal in catalog['signals']]
        return catalog
    def validate(self,bindings,catalog=None,probe=True):
        if len(bindings)>32: raise HTTPException(400,'At most 32 bindings are supported in this development worker')
        catalog=catalog or self.catalog();ids=set();pairs=set();aas_writers=set();gw_writers=set()
        correction_targets={'Temperature','XAxisPos','XAxisLoad'}
        if self.rules_getter: correction_targets.update(r.get('targetElement') for r in self.rules_getter() if r.get('targetElement'))
        for b in bindings:
            if not isinstance(b,dict) or not re.fullmatch(r'[A-Za-z0-9:_-]{1,128}',str(b.get('id',''))): raise HTTPException(400,'Invalid binding ID')
            if b['id'] in ids: raise HTTPException(400,'Duplicate binding ID')
            ids.add(b['id'])
            if b.get('direction') not in DIRECTIONS or type(b.get('intervalMs')) is not int or not 500<=b['intervalMs']<=60000: raise HTTPException(400,'Invalid direction or interval (500–60000 ms)')
            if b.get('startupAuthority') not in {'gateway','aas','manual'}: raise HTTPException(400,'Invalid startup authority')
            if type(b.get('enabled')) is not bool: raise HTTPException(400,'enabled must be boolean')
            signal=next((s for s in catalog['signals'] if s['key']==b.get('signalKey')),None)
            prop=next((p for p in catalog['properties'] if p['submodelId']==b.get('submodelId') and p['path']==b.get('path')),None)
            if not signal or not prop: raise HTTPException(400,'Binding has a missing or Engine-owned endpoint')
            if signal['valueType']!=prop['valueType'] or b.get('valueType')!=prop['valueType']: raise HTTPException(400,'Binding endpoint valueTypes must match exactly')
            pair=(signal['key'],prop['submodelId'],prop['path'])
            if pair in pairs: raise HTTPException(400,'Duplicate binding endpoints')
            pairs.add(pair)
            if not b['enabled']: continue
            if b['direction']!='aas_to_gateway':
                target=(prop['submodelId'],prop['path'])
                if target in aas_writers: raise HTTPException(400,'Only one enabled writer per AAS Property')
                aas_writers.add(target)
            if b['direction']!='gateway_to_aas':
                if signal['key'] in gw_writers: raise HTTPException(400,'Only one enabled writer per Gateway signal')
                gw_writers.add(signal['key'])
                # The Java Engine owns writes to its CNC correction targets.
                if signal['key'].startswith('cnc-line1.') and signal['key'].split('.',1)[1] in correction_targets:
                    raise HTTPException(400,'This signal is an Engine correction target; use another writable signal')
                if signal['protocol']!='OPC_UA': raise HTTPException(400,'Only verified OPC UA nodes support Gateway writes')
                if probe and (self.probe is None or not self.probe(signal)): raise HTTPException(400,'OPC UA write access could not be verified')
        return catalog
    def save(self,items,expected):
        with self.store.lock:
            data=self.store.read()
            if type(expected) is not int or expected!=data['revision']: raise HTTPException(412,'Bindings changed; refresh before saving')
            self.validate(items)
            allowed={'id','name','signalKey','submodelId','path','valueType','direction','intervalMs','startupAuthority','enabled'}
            if any(set(b)-allowed for b in items): raise HTTPException(400,'Unknown binding fields')
            data['bindings']=copy.deepcopy(items);data['revision']+=1;self.store.write(data)
        return self.snapshot()
    def snapshot(self):
        data=self.store.read()
        return {'revision':data['revision'],'bindings':data['bindings'],'states':copy.deepcopy(self.states),'workerError':self.worker_error,
                'runSnapshot':data['runSnapshot'],'events':data['events'][-100:]}
    def prepare(self,extra):
        data=self.store.read();catalog=self.validate(data['bindings'])
        for b in data['bindings']:
            if b['enabled']: self.read_pair(b)
        refs=[{k:p[k] for k in ('submodelId','path','valueType')} for p in catalog['properties'] if any(b['submodelId']==p['submodelId'] and b['path']==p['path'] for b in data['bindings'])]
        config={'bindings':data['bindings'],'references':refs,**extra}
        return {'fingerprint':fingerprint(config),'configuration':config,'preparedAt':int(time.time()*1000)}
    def commit_run(self,prepared,runtime):
        with self.store.lock:
            data=self.store.read();data['baselines']={};data['runSnapshot']={**prepared,'runId':runtime['runId'],'state':'RUNNING'};self.store.write(data)
        self.baselines.clear();self.next_due.clear();self.states.clear();self.run_id=runtime['runId']
    def stopped(self):
        with self.store.lock:
            data=self.store.read()
            if data['runSnapshot']: data['runSnapshot']['state']='STOPPED';self.store.write(data)
        self.baselines.clear();self.next_due.clear()
    def read_pair(self,b):
        entry=unpack(gateway.get_json(self.gateway,'/api/submodel')).get(b['signalKey'])
        if not isinstance(entry,dict): raise HTTPException(502,'Gateway signal is unavailable')
        qualifiers={q.get('type'):q.get('value') for q in entry.get('qualifiers',[])}
        if str(qualifiers.get('StatusCode','')).upper()!='OK': raise HTTPException(502,'Gateway signal is not OK')
        timestamp=qualifiers.get('ObservedAt') or qualifiers.get('Timestamp')
        try:
            # e.g. 2026-11-20T15:06:32.924722549Z (Gateway: UTC instants); older Pythons take at most 6 fraction digits
            stamp=datetime.fromisoformat(re.sub(r'(\.\d{6})\d+',r'\1',str(timestamp)).replace('Z','+00:00'))
            if stamp.tzinfo is None: stamp=stamp.replace(tzinfo=timezone.utc)
            age=time.time()-stamp.timestamp()
            if age>15 or age < -5: raise ValueError()
        except (ValueError,TypeError): raise HTTPException(502,'Gateway timestamp missing, stale or in the future')
        return typed(entry['value'],b['valueType']),typed(unpack(aas.get_value(self.base,b['submodelId'],b['path'])),b['valueType'])
    def execute(self,b,write=False):
        gv,av=self.read_pair(b);action=direction(b,self.baselines.get(b['id']),gv,av)
        report={'status':'READ','gatewayValue':gv,'aasValue':av,'plannedAction':action,'at':int(time.time()*1000)}
        if write:
            if action=='conflict': report.update(status='CONFLICT',message='Both endpoints changed; nothing overwritten')
            else:
                if action=='gateway_to_aas': aas.patch_value(self.base,b['submodelId'],b['path'],gv);av=gv
                if action=='aas_to_gateway': gateway.patch_value(self.gateway,b['signalKey'],av);gv=av
                self.baselines[b['id']]=[gv,av];report.update(status='OK',gatewayValue=gv,aasValue=av,message='Write acknowledged' if action!='none' else 'No change')
        self.states[b['id']]=report
        return report
    def manual(self,id,write):
        data=self.store.read();b=next((b for b in data['bindings'] if b['id']==id),None)
        if b is None: raise HTTPException(404,'Binding not found')
        checked={**b,'enabled':True} if write else b
        self.validate([checked]);return self.execute(b,write)
    def tick(self,runtime):
        self.worker_error=''
        if runtime.get('state')!='RUNNING': return
        data=self.store.read();snap=data['runSnapshot']
        if not snap or snap.get('runId')!=runtime.get('runId') or snap.get('state')!='RUNNING':
            self.worker_error='No matching committed run snapshot. Stop and Start through the UI controller; bindings are paused.';return
        if self.run_id!=runtime['runId']:
            self.run_id=runtime['runId'];self.baselines={};self.next_due={}
            # On restart, manual authority avoids silently picking a new winner.
            for b in snap['configuration']['bindings']:
                if b['direction']=='bidirectional': self.baselines[b['id']]=data.get('baselines',{}).get(b['id'])
        items=[b for b in snap['configuration']['bindings'] if b['enabled']]
        if not items: return
        for _ in items:
            b=items[self.cursor%len(items)];self.cursor+=1
            if time.monotonic()<self.next_due.get(b['id'],0): continue
            self.next_due[b['id']]=time.monotonic()+b['intervalMs']/1000
            try: result=self.execute(b,True)
            except Exception as error:
                result={'status':'ERROR','message':str(getattr(error,'detail',error)),'at':int(time.time()*1000)};self.states[b['id']]=result
            with self.store.lock:
                data=self.store.read();data['baselines']=self.baselines;data['events']=(data['events']+[{'bindingId':b['id'],'runId':runtime['runId'],**result}])[-100:];self.store.write(data)
            break

def install_bindings(app,bindings,lock,status):
    @app.get('/api/bindings')
    def list_bindings(): return bindings.snapshot()
    @app.get('/api/bindings/catalog')
    def binding_catalog(): return bindings.public_catalog()
    @app.put('/api/bindings')
    async def save_bindings(request:Request):
        body=await request.json()
        if not isinstance(body,dict) or not isinstance(body.get('bindings'),list): raise HTTPException(400,'bindings array required')
        return await run_in_threadpool(bindings.save,body['bindings'],body.get('revision'))
    @app.post('/api/bindings/{id}/test')
    def test_binding(id:str): return bindings.manual(id,False)
    @app.post('/api/bindings/{id}/write')
    async def write_binding(id:str,request:Request):
        body=await request.json()
        if not isinstance(body,dict) or body.get('confirm') is not True: raise HTTPException(400,'Confirm a real single value write with confirm=true')
        return await run_in_threadpool(bindings.manual,id,True)
    async def loop():
        while True:
            try:
                async with lock: await run_in_threadpool(lambda: bindings.tick(status()))
            except asyncio.CancelledError: raise
            except Exception as error: bindings.worker_error=str(getattr(error,'detail',error))
            await asyncio.sleep(.25)
    task=None
    @app.on_event('startup')
    async def start_worker():
        nonlocal task;task=asyncio.create_task(loop())
    @app.on_event('shutdown')
    async def stop_worker():
        if task: task.cancel()
