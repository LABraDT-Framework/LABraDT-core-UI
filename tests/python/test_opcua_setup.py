import base64
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from backend import opcua_setup as setup
from backend.gateway_management import GatewayManagement
from test_opcua_security import identity


class OpcUaSetupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        env = patch.dict(os.environ, {'GUC_OPCUA_SECURITY_DIR': str(self.root)})
        env.start(); self.addCleanup(env.stop)
        self.manager = GatewayManagement(self.root / 'configs', self.root / 'plugins', '', lambda *args, **kwargs: [])
        self.config = {'machineId': 'machine', 'protocol': 'OPC_UA', 'connection': {
            'endpoint': 'opc.tcp://localhost:4840', 'username': 'reader', 'password': 'fixture-secret'}, 'mappings': []}

    def server(self):
        cert = identity(self.root, 'server', 'urn:guc:server')
        raw = (self.root / 'server.der').read_bytes()
        return cert, base64.b64encode(raw).decode()

    def test_generation_and_concurrent_calls_reuse_identity(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: setup.prepare_identity(), range(2)))
        self.assertEqual(results[0]['fingerprint'], results[1]['fingerprint'])
        self.assertEqual(results[0]['applicationUri'], 'urn:dt-gateway:client')
        key = (self.root / 'client_key.pem').read_bytes()
        self.assertEqual(setup.prepare_identity()['fingerprint'], results[0]['fingerprint'])
        self.assertEqual(key, (self.root / 'client_key.pem').read_bytes())

    def test_partial_or_corrupt_identity_is_preserved(self):
        key_path = self.root / 'client_key.pem'; key_path.write_bytes(b'incomplete')
        with self.assertRaises(HTTPException) as failure: setup.prepare_identity()
        self.assertEqual(failure.exception.status_code, 409)
        self.assertEqual(key_path.read_bytes(), b'incomplete')
        self.assertFalse((self.root / 'client_cert.der').exists())

    def test_server_certificate_needs_matching_fingerprint_and_is_idempotent(self):
        cert, encoded = self.server()
        payload = {'certificateBase64': encoded, 'expectedFingerprint': '00' * 32}
        before = set(self.root.iterdir())
        with self.assertRaises(HTTPException): setup.confirm_server_certificate(payload)
        self.assertEqual(set(self.root.iterdir()), before)
        payload['expectedFingerprint'] = setup.metadata(cert)['fingerprint'].upper()
        result = setup.confirm_server_certificate(payload)
        self.assertEqual(result, setup.confirm_server_certificate(payload))
        self.assertTrue(result['fileName'].startswith('server-'))
        self.assertEqual((self.root / result['fileName']).read_bytes(), (self.root / 'server.der').read_bytes())

    def test_private_key_and_oversized_input_are_rejected(self):
        self.server()
        with self.assertRaises(HTTPException): setup.decode_certificate(base64.b64encode((self.root / 'server.pem').read_bytes()).decode())
        with self.assertRaises(HTTPException) as failure: setup.decode_certificate('A' * 140000)
        self.assertEqual(failure.exception.status_code, 413)

    def test_certificate_without_java_required_usage_is_rejected_before_trust(self):
        from datetime import datetime, timedelta, timezone
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Incomplete server')])
        now = datetime.now(timezone.utc)
        cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.UniformResourceIdentifier('urn:guc:incomplete')]), critical=False)
            .sign(key, hashes.SHA256()))
        encoded = base64.b64encode(cert.public_bytes(serialization.Encoding.DER)).decode()
        with self.assertRaises(HTTPException) as failure: setup.decode_certificate(encoded)
        self.assertIn('KeyUsage', failure.exception.detail)
        self.assertEqual(list(self.root.glob('server-*.der')), [])

    def test_password_is_hidden_and_kept_only_for_same_endpoint_and_account(self):
        self.manager.save('machine', self.config)
        public = self.manager.entries()[0]['config']
        self.assertNotIn('password', public['connection'])
        self.assertTrue(public['connection']['passwordSet'])
        self.manager.save('machine', public)
        saved = json.loads(self.manager.path('machine').read_text())
        self.assertEqual(saved['connection']['password'], 'fixture-secret')
        self.assertNotIn('passwordSet', saved['connection'])
        for field, value in [('endpoint', 'opc.tcp://other:4840'), ('username', 'other')]:
            changed = {**public, 'connection': {**public['connection'], field: value}}
            with self.assertRaises(HTTPException): self.manager.save('machine', changed)
        self.assertEqual(json.loads(self.manager.path('machine').read_text()), saved)

    def test_anonymous_and_environment_modes_clear_saved_password(self):
        self.manager.save('machine', self.config)
        anonymous = {**self.config, 'connection': {**self.config['connection'], 'authentication': 'Anonymous'}}
        self.manager.save('machine', anonymous)
        self.assertNotIn('password', json.loads(self.manager.path('machine').read_text())['connection'])
        environment = {**self.config, 'connection': {**self.config['connection'], 'authentication': 'Environment', 'usernameEnv': 'UA_USER', 'passwordEnv': 'UA_PASSWORD'}}
        self.manager.save('machine', environment)
        connection = json.loads(self.manager.path('machine').read_text())['connection']
        self.assertNotIn('username', connection); self.assertNotIn('password', connection)
        self.assertEqual(connection['passwordEnv'], 'UA_PASSWORD')

    def test_validate_prompts_for_password_after_endpoint_change(self):
        from backend import app as controller
        self.manager.save('machine', self.config)
        public = self.manager.entries()[0]['config']
        public['connection']['endpoint'] = 'opc.tcp://different:4840'
        with patch.object(controller, 'gateway_management', self.manager):
            result = controller.validate_gateway_config(public)
        self.assertFalse(result['valid'])
        self.assertIn('Re-enter the password', result['errors'][0])

    def test_http_setup_exposes_only_public_certificate(self):
        app = FastAPI(); setup.install_opcua_setup(app)
        routes = {route.path: route.endpoint for route in app.routes}
        self.assertEqual(routes['/api/gateway/opcua/security']()['client']['state'], 'missing')
        self.assertEqual(routes['/api/gateway/opcua/identity']()['state'], 'ready')
        download = routes['/api/gateway/opcua/client-certificate']()
        self.assertEqual(Path(download.path).read_bytes(), (self.root / 'client_cert.der').read_bytes())
        self.assertNotIn('/api/gateway/opcua/client_key.pem', routes)
        self.assertNotIn('PRIVATE KEY', json.dumps(routes['/api/gateway/opcua/security']()))

    def test_explicit_anonymous_discovery_does_not_reuse_account(self):
        from backend import app as controller
        self.manager.save('machine', self.config)
        with patch.object(controller, 'gateway_management', self.manager), patch.object(controller, 'browse_opcua_nodes', return_value=[]) as browse:
            controller.discover_opcua({'machineId': 'machine', 'endpoint': self.config['connection']['endpoint'], 'authentication': 'Anonymous'})
            self.assertNotIn('username', browse.call_args.kwargs['connection'])
            self.assertNotIn('password', browse.call_args.kwargs['connection'])
            controller.discover_opcua({'machineId': 'machine', 'endpoint': self.config['connection']['endpoint'], 'authentication': 'UsernamePassword', 'username': 'reader', 'passwordSet': True})
            self.assertEqual(browse.call_args.kwargs['connection']['password'], 'fixture-secret')
