"""Fetch a *candidate* public server certificate for operator fingerprint verification."""
import argparse
import asyncio
import hashlib
from pathlib import Path
from asyncua import Client, ua
from cryptography import x509
from cryptography.hazmat.primitives import serialization


async def inspect(endpoint, mode, output):
    if not endpoint.startswith('opc.tcp://'): raise ValueError('Use a complete opc.tcp:// endpoint')
    endpoints = await Client(endpoint, timeout=8).connect_and_get_server_endpoints()
    selected = next((e for e in endpoints if e.SecurityPolicyUri.endswith('#Basic256Sha256')
                     and e.SecurityMode == getattr(ua.MessageSecurityMode, mode)), None)
    if selected is None: raise ValueError(f'No Basic256Sha256/{mode} endpoint is advertised')
    certificate = x509.load_der_x509_certificate(selected.ServerCertificate)
    der = certificate.public_bytes(serialization.Encoding.DER)
    output.parent.mkdir(parents=True, exist_ok=True)
    # Never overwrite an existing candidate or trusted certificate.
    with output.open('xb') as stream: stream.write(der)
    print('Candidate public server certificate:', output.resolve())
    print('SHA-256:', hashlib.sha256(der).hexdigest())
    print('Compare this fingerprint with the operator before provisioning it as connection.serverCertificate.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--endpoint', required=True)
    parser.add_argument('--mode', choices=['Sign', 'SignAndEncrypt'], default='SignAndEncrypt')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    asyncio.run(inspect(args.endpoint, args.mode, args.output))


if __name__ == '__main__': main()
