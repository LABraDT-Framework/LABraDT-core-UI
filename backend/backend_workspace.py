"""The shared UI's operation metadata and SME workflows, persisted on the server.

AAS models stay in BaSyx; executable Services stay in Service Manager. This store
only keeps fields not represented by their APIs. No simulated Backend execution.
"""
from __future__ import annotations
import asyncio
import copy
import json
import time
from urllib.parse import unquote, quote
from fastapi import HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from . import aas_proxy as aas
from . import repository_proxy as repository
from .backend_bindings import typed, unpack, fingerprint
from .runtime_proxy import forward_json

# Set by app.py: the service catalog (project_model.ServiceCatalog) and the Rules page → Engine AASX sync
# (project_model.RulesPageSync.sync), so rules can be saved while the Runtime or the repository is stopped.
CATALOG = None
RULES_SYNC = None


class Workspace:
    def __init__(self, bindings):
        self.bindings = bindings
        self.states = {}

    def snapshot(self):
        data = self.bindings.store.read()
        return {**data.get('workspace', {'revision': 0, 'services': {}, 'rules': []}), 'states': copy.deepcopy(self.states)}

    def property(self, identity):
        try:
            _, submodel, path = [unquote(part) for part in identity.split('|')]
            model = repository.read_model(self.bindings.base, 'submodels', submodel)
            elements = model.get('submodelElements', [])
            for part in path.split('.'):
                element = next(item for item in elements if item.get('idShort') == part)
                elements = element.get('value', []) if isinstance(element.get('value'), list) else []
            if element.get('modelType') != 'Property': raise ValueError()
            return submodel, path, element['valueType']
        except (ValueError, KeyError, StopIteration, AttributeError):
            raise HTTPException(422, 'Referenced SME is missing or is not a scalar Property')

    def validate(self, rules):
        if not isinstance(rules, list) or len(rules) > 200: raise HTTPException(400, 'rules array required (maximum 200)')
        services = CATALOG.list()[0] if CATALOG is not None else unpack(forward_json(self.bindings.services, '/registry/services'))
        ids = {item['serviceId'] for item in services}
        seen = set()
        for rule in rules:
            if not isinstance(rule, dict) or not rule.get('id') or rule['id'] in seen: raise HTTPException(400, 'Rule IDs must be unique')
            seen.add(rule['id'])
            if rule.get('conditionMode', 'AND') not in {'AND', 'OR'}: raise HTTPException(400, 'Unsupported condition group')
            monitors = rule.get('monitors', [])
            if not monitors: raise HTTPException(400, 'Select at least one monitored SME')
            for monitor in monitors:
                _, _, kind = self.property(monitor['propertyId'])
                if monitor['condition']['operator'] not in {'>', '<', '=', '>=', '<=', '!='}: raise HTTPException(400, 'Unsupported comparison')
                typed(monitor['condition']['right']['value'], kind)
            call = rule.get('serviceCall', {})
            if call.get('serviceId') not in ids: raise HTTPException(422, 'Rule Service is not registered (Services page)')
            for binding in call.get('bindings', {}).values():
                if binding.get('source') == 'property': self.property(binding['propertyId'])
                elif binding.get('source') != 'constant': raise HTTPException(400, 'Unsupported argument source')
            if rule.get('output', {}).get('kind') == 'aas_property':
                sm, _, _ = self.property(rule['output']['propertyId'])
                model = repository.read_model(self.bindings.base, 'submodels', sm)
                if model.get('idShort') in repository.RESERVED: raise HTTPException(409, 'Choose a custom output Property; Engine-owned Submodels already have a writer')

    def save(self, body):
        if not isinstance(body, dict) or not isinstance(body.get('services'), dict): raise HTTPException(400, 'services metadata object required')
        self.validate(body.get('rules'))
        with self.bindings.store.lock:
            data = self.bindings.store.read()
            old = data.get('workspace', {'revision': 0})
            if type(body.get('revision')) is not int or body['revision'] != old['revision']: raise HTTPException(412, 'Workspace changed; refresh before saving')
            # Rules the Engine can run go into the engine AASX (Rules_SM); the others stay with the UI controller.
            rules = RULES_SYNC(copy.deepcopy(body['rules'])) if RULES_SYNC is not None else copy.deepcopy(body['rules'])
            data['workspace'] = {'revision': old['revision'] + 1, 'services': copy.deepcopy(body['services']), 'rules': rules}
            self.bindings.store.write(data)
        return self.snapshot()

    def prepare(self):
        workspace = self.snapshot()
        self.validate(workspace['rules'])
        return {key: workspace[key] for key in ('services', 'rules')}

    def value(self, identity):
        sm, path, kind = self.property(identity)
        return typed(unpack(aas.get_value(self.bindings.base, sm, path)), kind)

    def inputs(self, rule):
        return [self.value(monitor['propertyId']) for monitor in rule['monitors']]

    async def execute(self, rule, status, lock=None, run_id=None):
        trace = []
        state = {'status': 'Running', 'conditionResult': None, 'trace': trace, 'lastRunAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
        self.states[rule['id']] = state
        try:
            values = await run_in_threadpool(self.inputs, rule)
            evaluations = []
            for monitor, left in zip(rule['monitors'], values):
                _, _, kind = await run_in_threadpool(self.property, monitor['propertyId'])
                right = typed(monitor['condition']['right']['value'], kind)
                op = monitor['condition']['operator']
                result = {'=': lambda: left == right, '!=': lambda: left != right, '>': lambda: left > right, '<': lambda: left < right, '>=': lambda: left >= right, '<=': lambda: left <= right}[op]()
                evaluations.append(result)
                trace.append({'label': 'Condition', 'detail': f'{left} {op} {right} → {result}', 'status': 'True' if result else 'False'})
            state['conditionResult'] = any(evaluations) if rule.get('conditionMode') == 'OR' else all(evaluations)
            if not state['conditionResult']:
                state.update(status='No action', message='Conditions not matched · Nothing', writtenTo='Empty')
                return state
            args = {}
            for name, binding in rule['serviceCall'].get('bindings', {}).items():
                value = await run_in_threadpool(self.value, binding['propertyId']) if binding['source'] == 'property' else binding.get('value', '')
                args[name] = str(value).lower() if isinstance(value, bool) else str(value)
            service_id = rule['serviceCall']['serviceId']
            execution = unpack(await run_in_threadpool(forward_json, self.bindings.services, '/services/trigger', method='POST', payload={'serviceIds': [service_id], 'dynamicArgs': args}))
            execution_id = execution['triggered'][0]['executionId']
            for _ in range(120):
                current = await run_in_threadpool(status)
                if run_id and (current.get('runId') != run_id or current.get('state') != 'RUNNING'): raise asyncio.CancelledError()
                result = unpack(await run_in_threadpool(forward_json, self.bindings.services, '/services/status?executionId=' + quote(execution_id, safe='')))
                if result.get('status') in {'COMPLETED', 'FAILED', 'CANCELLED', 'NOT_FOUND'}: break
                await asyncio.sleep(.25)
            else: raise HTTPException(504, 'Service execution timed out')
            if result.get('status') != 'COMPLETED': raise HTTPException(502, 'Service execution failed: ' + str(result.get('status')))
            result = unpack(await run_in_threadpool(forward_json, self.bindings.services, '/services/result?executionId=' + quote(execution_id, safe='')))
            if result.get('success') is False: raise HTTPException(502, result.get('errorMessage') or 'Service execution failed')
            output = result.get('outputData')
            trace.append({'label': service_id, 'detail': f'{json.dumps(args)} → {output}', 'status': 'Success'})
            async def write_output():
                if run_id:
                    current = await run_in_threadpool(status)
                    if current.get('state') != 'RUNNING' or current.get('runId') != run_id: raise asyncio.CancelledError()
                if rule.get('output', {}).get('kind') == 'aas_property':
                    sm, path, kind = await run_in_threadpool(self.property, rule['output']['propertyId'])
                    await run_in_threadpool(aas.patch_value, self.bindings.base, sm, path, typed(output, kind))
                    state['writtenTo'] = path
                    trace.append({'label': 'Output', 'detail': f'{output} → {path}', 'status': 'Written'})
                else: state['writtenTo'] = 'Empty'
            if lock:
                async with lock: await write_output()
            else: await write_output()
            state.update(status='Success', message='Service completed', serviceOutput=output, finalOutput=output, executionId=execution_id)
        except asyncio.CancelledError:
            state.update(status='Paused', message='Automatic execution stopped · output not applied')
        except Exception as error:
            state.update(status='Failed', message=str(getattr(error, 'detail', error)))
            trace.append({'label': 'Error', 'detail': state['message'], 'status': 'Failed'})
        return state


def install_workspace(app, workspace, lock, status):
    @app.get('/api/workspace')
    def get_workspace(): return workspace.snapshot()

    @app.put('/api/workspace')
    async def save_workspace(request: Request): return await run_in_threadpool(workspace.save, await request.json())

    @app.post('/api/workspace/test')
    async def test_workflow(request: Request):
        rule = (await request.json()).get('rule')
        await run_in_threadpool(workspace.validate, [rule])
        return await workspace.execute(rule, status)

    async def worker():
        tasks, observed, active_run = {}, {}, None
        try:
            while True:
                try:
                    runtime = await run_in_threadpool(status)
                    run = runtime.get('runId') if runtime.get('state') == 'RUNNING' else None
                    if run != active_run:
                        for task in tasks.values(): task.cancel()
                        tasks, observed, active_run = {}, {}, run
                    data = await run_in_threadpool(workspace.bindings.store.read)
                    snapshot = data.get('runSnapshot') or {}
                    if run and snapshot.get('runId') == run and snapshot.get('state') == 'RUNNING':
                        for rule in snapshot['configuration'].get('workspace', {}).get('rules', []):
                            if rule.get('executor') == 'engine': continue  # written into the engine AASX: the Engine runs it
                            if not rule.get('enabled', True) or rule['id'] in tasks and not tasks[rule['id']].done(): continue
                            signature = fingerprint(await run_in_threadpool(workspace.inputs, rule))
                            if observed.get(rule['id']) == signature: continue
                            observed[rule['id']] = signature
                            tasks[rule['id']] = asyncio.create_task(workspace.execute(rule, status, lock, run))
                except HTTPException:
                    pass  # Dependency health is reported by the existing runtime/health UI.
                await asyncio.sleep(1)
        finally:
            for task in tasks.values(): task.cancel()
            await asyncio.gather(*tasks.values(), return_exceptions=True)
    task = None
    @app.on_event('startup')
    async def start():
        nonlocal task
        task = asyncio.create_task(worker())
    @app.on_event('shutdown')
    async def stop():
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
