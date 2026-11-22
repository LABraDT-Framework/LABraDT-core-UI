import asyncio
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, MagicMock
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
from fastapi import HTTPException
from backend import opcua_security as module


def identity(directory, prefix, uri='urn:guc:test'):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'GUC test')])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.UniformResourceIdentifier(uri), x509.DNSName('localhost')]), critical=False)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=True, key_encipherment=True,
                data_encipherment=True, key_agreement=False, key_cert_sign=False, crl_sign=False, encipher_only=None, decipher_only=None), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH, ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .sign(key, hashes.SHA256()))
    (directory / (prefix + '.der')).write_bytes(cert.public_bytes(serialization.Encoding.DER))
    (directory / (prefix + '.pem')).write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    return cert


class OpcUaSecurityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        env = patch.dict(os.environ, {'GUC_OPCUA_SECURITY_DIR': str(self.root)})
        env.start(); self.addCleanup(env.stop)
        self.connection = {'endpoint': 'opc.tcp://localhost:4840', 'securityPolicy': 'Basic256Sha256',
                           'securityMode': 'Sign', 'serverCertificate': 'server.der'}

    def prepare(self):
        identity(self.root, 'client_cert')
        (self.root / 'client_cert.pem').rename(self.root / 'client_key.pem')
        return identity(self.root, 'server', 'urn:guc:server')

    def test_none_keeps_unsecured_compatibility(self):
        with patch('asyncua.sync.Client') as factory:
            client = module.create_client({'endpoint': 'opc.tcp://localhost:4840'})
            client.set_security.assert_not_called()

    def test_invalid_endpoints_fail_before_creating_a_client_thread(self):
        for endpoint in ('opc.tcp://', 'opc.tcp://localhost:invalid', 'http://localhost:4840', 'opc.tcp://user:password@localhost:4840'):
            with patch('asyncua.sync.Client') as factory, self.assertRaises(HTTPException) as failure:
                module.create_client({'endpoint': endpoint})
            self.assertEqual(failure.exception.status_code, 400); factory.assert_not_called()

    def test_environment_credentials_and_mode_apply_without_exposing_secrets(self):
        trusted = self.prepare()
        with patch.dict(os.environ, {'TEST_UA_USER': 'reader', 'TEST_UA_PASSWORD': 'test-secret'}), patch('asyncua.sync.Client') as factory:
            client = module.create_client({**self.connection, 'usernameEnv': 'TEST_UA_USER', 'passwordEnv': 'TEST_UA_PASSWORD'})
            client.set_user.assert_called_once_with('reader'); client.set_password.assert_called_once_with('test-secret')
            from asyncua import ua
            self.assertEqual(client.set_security.call_args.kwargs['mode'], ua.MessageSecurityMode.Sign)
            self.assertEqual(client.application_uri, 'urn:guc:test')
            self.assertEqual(client.set_security.call_args.kwargs['server_certificate'], trusted.public_bytes(serialization.Encoding.DER))

    def test_missing_secret_or_trusted_certificate_fails_before_client_creation(self):
        for connection in ({**self.connection, 'passwordEnv': 'GUC_TEST_UNSET_VARIABLE'}, self.connection):
            with patch('asyncua.sync.Client') as factory, self.assertRaises(HTTPException): module.create_client(connection)
            factory.assert_not_called()

    def test_policy_and_mode_are_not_downgraded(self):
        for connection in ({**self.connection, 'securityMode': 'None'}, {**self.connection, 'securityPolicy': 'Unknown'}):
            with self.assertRaises(HTTPException) as error: module.create_client(connection)
            self.assertEqual(error.exception.status_code, 400)

    def test_certificate_path_cannot_escape_security_directory(self):
        with self.assertRaises(HTTPException) as error: module.certificate_path('../outside.der')
        self.assertEqual(error.exception.status_code, 400)

    def test_mismatched_private_key_is_rejected_without_replacing_files(self):
        self.prepare(); identity(self.root, 'other')
        key_path = self.root / 'client_key.pem'; key_path.write_bytes((self.root / 'other.pem').read_bytes())
        before = key_path.read_bytes()
        with self.assertRaises(HTTPException): module.create_client(self.connection)
        self.assertEqual(before, key_path.read_bytes())

    def test_python_rejects_changed_server_certificate_uri_and_hostname(self):
        trusted = self.prepare(); changed = identity(self.root, 'changed', 'urn:guc:server')
        with patch('asyncua.sync.Client') as factory:
            client = module.create_client(self.connection)
            validate = client.aio_obj.certificate_validator
            description = MagicMock(ApplicationUri='urn:guc:server')
            asyncio.run(validate(trusted, description))
            with self.assertRaises(Exception): asyncio.run(validate(changed, description))
            with self.assertRaises(Exception): asyncio.run(validate(trusted, MagicMock(ApplicationUri='urn:wrong')))

    def test_saved_credentials_are_bound_to_exact_saved_endpoint(self):
        from backend import app as controller
        path = self.root / 'machine.json'
        saved = {**self.connection, 'username': 'reader', 'password': 'test-secret'}
        path.write_text(json.dumps({'connection': saved}))
        with patch.object(controller.gateway_management, 'locate', return_value=(path, True)), patch.object(controller, 'browse_opcua_nodes', return_value=[]) as browse:
            result = controller.discover_opcua({'machineId': 'machine', 'endpoint': self.connection['endpoint']})
            self.assertEqual(browse.call_args.kwargs['connection']['password'], 'test-secret')
            self.assertNotIn('password', result)
            controller.discover_opcua({'machineId': 'machine', 'endpoint': 'opc.tcp://another-host:4840'})
            self.assertNotIn('password', browse.call_args.kwargs['connection'])
            controller.discover_opcua({'machineId': 'machine', 'endpoint': self.connection['endpoint'], 'username': 'other'})
            self.assertNotIn('password', browse.call_args.kwargs['connection'])
