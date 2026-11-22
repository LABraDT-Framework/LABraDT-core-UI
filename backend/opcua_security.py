"""OPC UA browser uses the same persistent application identity as Java Gateway."""
from __future__ import annotations
import ipaddress
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID
from fastapi import HTTPException
from .settings import GATEWAY_DIR


def security_dir() -> Path:
    return Path(os.getenv('GUC_OPCUA_SECURITY_DIR', str(GATEWAY_DIR / 'security'))).resolve()


def validate_endpoint(endpoint: str):
    try:
        parsed = urlsplit(endpoint)
        port = parsed.port
    except ValueError as error:
        raise HTTPException(400, 'Enter a valid OPC UA hostname/IP and port') from error
    if parsed.scheme != 'opc.tcp' or not parsed.hostname or parsed.username or parsed.password or (port is not None and port == 0):
        raise HTTPException(400, 'Enter an opc.tcp:// endpoint without embedded credentials')
    return parsed


def certificate_path(filename: str) -> Path:
    root = security_dir()
    path = (root / filename).resolve()
    if not path.is_relative_to(root):
        raise HTTPException(400, 'OPC UA certificate must be inside GUC_OPCUA_SECURITY_DIR')
    if not path.is_file():
        raise HTTPException(503, 'OPC UA certificate file is missing; prepare the identity and provision the verified server certificate')
    return path


def credential(connection: dict, field: str) -> str:
    name = connection.get(field + 'Env')
    if name:
        value = os.getenv(str(name))
        if not value:
            raise HTTPException(503, f'Missing OPC UA credential environment variable: {name}')
        return value
    return str(connection.get(field) or '')


def read_certificate(path: Path) -> x509.Certificate:
    data = path.read_bytes()
    return x509.load_pem_x509_certificate(data) if data.startswith(b'-----') else x509.load_der_x509_certificate(data)


def check_validity(cert: x509.Certificate) -> None:
    now = datetime.now(timezone.utc)
    if not cert.not_valid_before_utc <= now <= cert.not_valid_after_utc:
        raise ValueError('OPC UA certificate is expired or not yet valid; existing identity was preserved')


def check_application_certificate(cert: x509.Certificate, role: str) -> None:
    """Match Milo's application KeyUsage and ExtendedKeyUsage checks."""
    check_validity(cert)
    key = cert.public_key()
    if not isinstance(key, rsa.RSAPublicKey) or key.key_size < 2048:
        raise ValueError(f'{role.capitalize()} certificate requires an RSA key of at least 2048 bits')
    try:
        usage = cert.extensions.get_extension_for_class(x509.KeyUsage).value
        if not all((usage.digital_signature, usage.content_commitment, usage.key_encipherment, usage.data_encipherment)):
            raise ValueError(f'{role.capitalize()} certificate requires digitalSignature, nonRepudiation, keyEncipherment and dataEncipherment')
        extended = cert.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
        required = ExtendedKeyUsageOID.CLIENT_AUTH if role == 'client' else ExtendedKeyUsageOID.SERVER_AUTH
        if required not in extended:
            raise ValueError(f'{role.capitalize()} certificate does not permit {role} authentication')
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        if not san.get_values_for_type(x509.UniformResourceIdentifier):
            raise ValueError(f'{role.capitalize()} certificate requires an application URI SAN')
    except x509.ExtensionNotFound as error:
        raise ValueError(f'{role.capitalize()} certificate requires KeyUsage, ExtendedKeyUsage and application URI extensions') from error


def create_client(connection: dict, timeout: float = 8):
    from asyncua import ua
    from asyncua.sync import Client
    from asyncua.crypto import security_policies
    endpoint = str(connection.get('endpoint') or '')
    validate_endpoint(endpoint)
    policy = str(connection.get('securityPolicy') or 'None')
    username, password = credential(connection, 'username'), credential(connection, 'password')
    options = None
    if policy != 'None':
        if policy != 'Basic256Sha256':
            raise HTTPException(400, 'The secured browser currently supports Basic256Sha256')
        mode = connection.get('securityMode') or 'SignAndEncrypt'
        if mode not in {'Sign', 'SignAndEncrypt'}:
            raise HTTPException(400, 'Secured OPC UA requires Sign or SignAndEncrypt')
        if not connection.get('serverCertificate'):
            raise HTTPException(400, 'Configure connection.serverCertificate with the verified server certificate filename')
        cert_path, key_path = certificate_path('client_cert.der'), certificate_path('client_key.pem')
        trusted_path = certificate_path(str(connection['serverCertificate']))
        try:
            cert, trusted = read_certificate(cert_path), read_certificate(trusted_path)
            check_application_certificate(cert, 'client'); check_application_certificate(trusted, 'server')
            key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
            if not isinstance(key, rsa.RSAPrivateKey) or key.key_size < 2048:
                raise ValueError('OPC UA identity needs an RSA private key of at least 2048 bits')
            if key.public_key().public_numbers() != cert.public_key().public_numbers():
                raise ValueError('OPC UA certificate and private key do not match')
            uri = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.UniformResourceIdentifier)[0]
        except (ValueError, TypeError, IndexError, x509.ExtensionNotFound) as error:
            raise HTTPException(503, str(error)) from error
        options = (cert_path, key_path, trusted, uri, mode)

    client = Client(endpoint, timeout=timeout, sync_wrapper_timeout=timeout + 5)
    try:
        if username:
            client.set_user(username); client.set_password(password)
        if options:
            cert_path, key_path, trusted, uri, mode = options
            client.application_uri = uri
            trusted_der = trusted.public_bytes(serialization.Encoding.DER)

            async def validate_server(cert, description):
                if cert.public_bytes(serialization.Encoding.DER) != trusted_der:
                    raise ua.UaStatusCodeError(ua.StatusCodes.BadCertificateUntrusted)
                try:
                    check_validity(cert)
                    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
                    if description.ApplicationUri not in san.get_values_for_type(x509.UniformResourceIdentifier):
                        raise ua.UaStatusCodeError(ua.StatusCodes.BadCertificateUriInvalid)
                    host = urlsplit(endpoint).hostname
                    try:
                        matched = ipaddress.ip_address(host) in san.get_values_for_type(x509.IPAddress)
                    except ValueError:
                        matched = host.lower() in [n.lower() for n in san.get_values_for_type(x509.DNSName)]
                    if not matched: raise ua.UaStatusCodeError(ua.StatusCodes.BadCertificateHostNameInvalid)
                except (ValueError, x509.ExtensionNotFound) as error:
                    raise ua.UaStatusCodeError(ua.StatusCodes.BadCertificateInvalid) from error

            client.aio_obj.certificate_validator = validate_server
            client.set_security(security_policies.SecurityPolicyBasic256Sha256,
                                certificate=str(cert_path), private_key=str(key_path),
                                server_certificate=trusted_der, mode=getattr(ua.MessageSecurityMode, mode))
        return client
    except Exception:
        client.disconnect_socket()
        raise
