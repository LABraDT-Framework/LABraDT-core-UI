"""Persistent OPC UA identity and explicitly confirmed server certificates."""
from __future__ import annotations

import base64
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
from urllib.parse import urlsplit

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from fastapi import HTTPException
from fastapi.responses import FileResponse

from .opcua_security import check_validity, check_application_certificate, read_certificate, security_dir, validate_endpoint

_identity_lock = threading.Lock()
_URI = 'urn:dt-gateway:client'
_MAX_CERTIFICATE = 64 * 1024


def public_config(config):
    result = deepcopy(config)
    connection = result.get('connection', {})
    if 'password' in connection:
        password = connection.get('password')
        # ${VARIABLE} placeholders are references, not secrets: keep them visible (e.g. MQTT credentials).
        if not (isinstance(password, str) and password.startswith('${') and password.endswith('}')):
            connection['passwordSet'] = bool(connection.pop('password'))
    return result


def credentials(connection, saved=None):
    """Keep a hidden saved password only for the same endpoint and account."""
    result = dict(connection)
    mode = result.pop('authentication', None)
    keep_password = result.pop('passwordSet', False)
    if mode == 'Anonymous':
        for key in ('username', 'password', 'usernameEnv', 'passwordEnv'):
            result.pop(key, None)
    elif mode == 'Environment':
        result.pop('username', None); result.pop('password', None)
        if not result.get('usernameEnv') or not result.get('passwordEnv'):
            raise HTTPException(422, 'Enter both credential environment variable names')
    elif mode == 'UsernamePassword' or keep_password:
        result.pop('usernameEnv', None); result.pop('passwordEnv', None)
        if not str(result.get('username') or '').strip():
            raise HTTPException(422, 'Enter an OPC UA username')
        if not result.get('password') and keep_password:
            saved = saved or {}
            if (saved.get('endpoint') != result.get('endpoint') or saved.get('username') != result.get('username')
                    or saved.get('usernameEnv') or saved.get('passwordEnv') or not saved.get('password')):
                raise HTTPException(409, 'Re-enter the password after changing the machine endpoint or username')
            result['password'] = saved['password']
    elif mode is not None:
        raise HTTPException(422, 'Choose Anonymous, UsernamePassword or Environment authentication')
    return result


def metadata(cert, filename=''):
    check_validity(cert)
    der = cert.public_bytes(serialization.Encoding.DER)
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        uris = san.get_values_for_type(x509.UniformResourceIdentifier)
        hosts = san.get_values_for_type(x509.DNSName) + [str(address) for address in san.get_values_for_type(x509.IPAddress)]
    except x509.ExtensionNotFound:
        uris, hosts = [], []
    return {'fileName': filename, 'subject': cert.subject.rfc4514_string(),
            'fingerprint': ':'.join(f'{b:02x}' for b in hashlib.sha256(der).digest()),
            'applicationUri': uris[0] if uris else '', 'hosts': hosts,
            'validUntil': cert.not_valid_after_utc.isoformat()}


def identity_metadata():
    root = security_dir()
    cert_path, key_path = root / 'client_cert.der', root / 'client_key.pem'
    if not cert_path.exists() and not key_path.exists():
        return {'state': 'missing', 'message': 'Generate a client certificate before connecting securely.'}
    try:
        if not cert_path.is_file() or not key_path.is_file():
            raise ValueError('Client identity is incomplete. Restore the matching certificate and private key.')
        if not cert_path.resolve().is_relative_to(root) or not key_path.resolve().is_relative_to(root):
            raise ValueError('Client identity must remain inside the security directory.')
        cert = read_certificate(cert_path)
        check_application_certificate(cert, 'client')
        key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
        if not isinstance(key, rsa.RSAPrivateKey) or key.key_size < 2048:
            raise ValueError('Client identity needs an RSA key of at least 2048 bits.')
        if key.public_key().public_numbers() != cert.public_key().public_numbers():
            raise ValueError('Client certificate and private key do not match.')
        info = metadata(cert, 'client_cert.der')
        if not info['applicationUri']:
            raise ValueError('Client certificate requires an application URI SAN.')
        return {'state': 'ready', **info}
    except (OSError, ValueError, TypeError, AttributeError) as error:
        return {'state': 'invalid', 'message': str(error)}


@contextmanager
def identity_lock(root):
    root.mkdir(parents=True, exist_ok=True)
    lock_path = root / '.identity.lock'
    if not lock_path.resolve().is_relative_to(root):
        raise HTTPException(409, 'Identity lock must remain inside the security directory')
    with _identity_lock, lock_path.open('a+b') as handle:
        if handle.tell() == 0:
            handle.write(b'\0'); handle.flush()
        deadline = time.monotonic() + 8
        while True:
            try:
                handle.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.lockf(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise HTTPException(409, 'Client identity is being prepared by another process; retry shortly')
                time.sleep(.1)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.lockf(handle.fileno(), fcntl.LOCK_UN)


def atomic_identity_file(path, data, private=False):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        try:
            if private and os.name != 'nt': os.chmod(temporary, 0o600)
            handle.write(data); handle.flush(); os.fsync(handle.fileno())
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def prepare_identity():
    root = security_dir()
    try:
        with identity_lock(root):
            info = identity_metadata()
            if info['state'] == 'ready': return info
            if info['state'] != 'missing': raise HTTPException(409, info['message'])
            if os.name != 'nt': os.chmod(root, 0o700)
            key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'GUC OPC UA Client')])
            now = datetime.now(timezone.utc)
            names = [x509.UniformResourceIdentifier(_URI), x509.DNSName('localhost')]
            hostname = socket.gethostname()
            if hostname and hostname != 'localhost': names.append(x509.DNSName(hostname))
            import ipaddress
            names.append(x509.IPAddress(ipaddress.ip_address('127.0.0.1')))
            cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
                    .public_key(key.public_key()).serial_number(x509.random_serial_number())
                    .not_valid_before(now - timedelta(minutes=5)).not_valid_after(now + timedelta(days=1095))
                    .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                    .add_extension(x509.SubjectAlternativeName(names), critical=False)
                    .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=True,
                        key_encipherment=True, data_encipherment=True, key_agreement=False,
                        key_cert_sign=False, crl_sign=False, encipher_only=None, decipher_only=None), critical=True)
                    .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False)
                    .sign(key, hashes.SHA256()))
            atomic_identity_file(root / 'client_key.pem', key.private_bytes(serialization.Encoding.PEM,
                                 serialization.PrivateFormat.PKCS8, serialization.NoEncryption()), private=True)
            atomic_identity_file(root / 'client_cert.der', cert.public_bytes(serialization.Encoding.DER))
            return identity_metadata()
    except OSError as error:
        raise HTTPException(503, 'Certificate directory is not writable; recreate the updated UI container and check volume permissions') from error


def decode_certificate(encoded):
    if not isinstance(encoded, str) or len(encoded) > _MAX_CERTIFICATE * 2:
        raise HTTPException(413, 'Server certificate exceeds 64 KiB')
    try:
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) > _MAX_CERTIFICATE: raise HTTPException(413, 'Server certificate exceeds 64 KiB')
        cert = x509.load_pem_x509_certificate(raw) if raw.startswith(b'-----') else x509.load_der_x509_certificate(raw)
        check_application_certificate(cert, 'server')
        key = cert.public_key()
        if not isinstance(key, rsa.RSAPublicKey) or key.key_size < 2048:
            raise ValueError('Basic256Sha256 requires an RSA server certificate of at least 2048 bits')
        try:
            if cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
                raise ValueError('Import the server application certificate, rather than a CA certificate')
        except x509.ExtensionNotFound: pass
        info = metadata(cert)
        if not info['applicationUri']: raise ValueError('Server certificate requires an application URI SAN')
        return cert
    except (ValueError, TypeError) as error:
        raise HTTPException(422, str(error)) from error


def confirm_server_certificate(payload):
    cert = decode_certificate(payload.get('certificateBase64'))
    info = metadata(cert)
    expected = str(payload.get('expectedFingerprint') or '').replace(':', '').replace(' ', '').lower()
    actual = info['fingerprint'].replace(':', '')
    if expected != actual:
        raise HTTPException(422, 'SHA-256 fingerprint does not match; confirm it with the machine administrator')
    filename = f'server-{actual[:24]}.der'
    root = security_dir()
    try:
        with identity_lock(root):
            path = root / filename
            if not path.resolve().is_relative_to(root): raise HTTPException(409, 'Server certificate must remain inside the security directory')
            raw = cert.public_bytes(serialization.Encoding.DER)
            if path.exists() and path.read_bytes() != raw: raise HTTPException(409, 'Existing certificate file differs; it was preserved')
            if not path.exists(): atomic_identity_file(path, raw)
        return metadata(cert, filename)
    except OSError as error:
        raise HTTPException(503, 'Certificate directory is not writable; recreate the updated UI container') from error


def discover_server_certificate(payload):
    from asyncua import ua
    from asyncua.sync import Client
    endpoint = str(payload.get('endpoint') or '').strip()
    validate_endpoint(endpoint)
    mode = payload.get('securityMode') or 'SignAndEncrypt'
    if mode not in ('Sign', 'SignAndEncrypt'): raise HTTPException(400, 'Choose Sign or SignAndEncrypt')
    client = Client(endpoint, timeout=8, sync_wrapper_timeout=13)
    try:
        endpoints = client.connect_and_get_server_endpoints()
        for advertised in endpoints:
            if (advertised.SecurityPolicyUri.endswith('#Basic256Sha256')
                    and advertised.SecurityMode == getattr(ua.MessageSecurityMode, mode) and advertised.ServerCertificate):
                # Servers may advertise a DER chain; pin the application leaf.
                raw = advertised.ServerCertificate
                if raw[0] != 0x30: raise ValueError('Invalid DER certificate chain')
                if raw[1] < 128: end = 2 + raw[1]
                else:
                    length_bytes = raw[1] & 127
                    if not 1 <= length_bytes <= 4: raise ValueError('Invalid DER certificate length')
                    end = 2 + length_bytes + int.from_bytes(raw[2:2 + length_bytes], 'big')
                cert = x509.load_der_x509_certificate(raw[:end])
                encoded = base64.b64encode(cert.public_bytes(serialization.Encoding.DER)).decode()
                cert = decode_certificate(encoded)
                return {**metadata(cert), 'certificateBase64': encoded}
        raise HTTPException(422, f'Server does not advertise Basic256Sha256 / {mode}')
    except HTTPException: raise
    except Exception as error:
        raise HTTPException(502, f'Could not discover the server certificate: {type(error).__name__}: {error}') from error
    finally:
        client.disconnect_socket()


def install_opcua_setup(app):
    @app.get('/api/gateway/opcua/security')
    def status():
        certificates = []
        for path in sorted(security_dir().glob('*')):
            if path.name == 'client_cert.der' or path.suffix.lower() not in ('.der', '.cer', '.crt', '.pem'): continue
            if not path.resolve().is_relative_to(security_dir()) or not path.is_file(): continue
            try:
                cert = read_certificate(path); check_application_certificate(cert, 'server')
                certificates.append(metadata(cert, path.name))
            except (OSError, ValueError, TypeError): continue
        return {'client': identity_metadata(), 'serverCertificates': certificates}

    @app.post('/api/gateway/opcua/identity')
    def generate():
        return prepare_identity()

    @app.get('/api/gateway/opcua/client-certificate')
    def download():
        info = identity_metadata()
        if info['state'] != 'ready': raise HTTPException(409, info.get('message', 'Generate the client identity first'))
        return FileResponse(security_dir() / 'client_cert.der', media_type='application/pkix-cert', filename='guc-client.der')

    @app.post('/api/gateway/opcua/server-certificate/inspect')
    def inspect(payload: dict):
        return metadata(decode_certificate(payload.get('certificateBase64')))

    @app.post('/api/gateway/opcua/server-certificate/discover')
    def discover(payload: dict):
        return discover_server_certificate(payload)

    @app.post('/api/gateway/opcua/server-certificate/confirm')
    def confirm(payload: dict):
        return confirm_server_certificate(payload)
