"""Regression coverage for relocated frontend assets and restricted static serving."""
import asyncio
from html.parser import HTMLParser
from pathlib import Path
import sys
import unittest
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from backend.app import app


class Resources(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key in {'src', 'href'} and value and not urlsplit(value).scheme:
                self.urls.append('/' + value.lstrip('/'))


async def get(url):
    parsed = urlsplit(url)
    responses = []
    request_sent = False

    async def receive():
        nonlocal request_sent
        if not request_sent:
            request_sent = True
            return {'type': 'http.request', 'body': b'', 'more_body': False}
        await asyncio.Event().wait()

    async def send(message):
        responses.append(message)

    scope = {'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1',
             'method': 'GET', 'scheme': 'http', 'path': parsed.path,
             'raw_path': parsed.path.encode(), 'query_string': parsed.query.encode(),
             'root_path': '', 'headers': [], 'client': ('127.0.0.1', 12345),
             'server': ('test', 80)}
    await app(scope, receive, send)
    status = next(message['status'] for message in responses if message['type'] == 'http.response.start')
    body = b''.join(message.get('body', b'') for message in responses if message['type'] == 'http.response.body')
    return status, body


class StaticRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_home_health_and_all_linked_assets_are_served(self):
        status, body = await get('/')
        self.assertEqual(status, 200)
        self.assertIn(b'LABraDT', body)
        resources = Resources()
        resources.feed(body.decode('utf-8'))
        self.assertGreater(len(resources.urls), 20)
        for url in resources.urls:
            with self.subTest(url=url):
                status, content = await get(url)
                self.assertEqual(status, 200)
                self.assertTrue(content)
        self.assertEqual((await get('/health'))[0], 200)

    async def test_legacy_static_alias_serves_assets_without_exposing_server_files(self):
        self.assertEqual((await get('/static/assets/images/isw-logo.png'))[0], 200)
        for url in ['/static/backend/app.py', '/static/config/basyx.properties',
                    '/static/requirements.txt', '/static/../backend/app.py']:
            with self.subTest(url=url):
                self.assertEqual((await get(url))[0], 404)
