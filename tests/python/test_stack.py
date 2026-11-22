"""Stack control: CLI-equivalent AASX rule editing, config validation and process supervision."""
import base64
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from fastapi import HTTPException
from backend import stack as module

RULES_XML = """<?xml version="1.0"?><environment><submodels><submodel><idShort>Rules-SM</idShort><submodelElements>
<submodelElementCollection>
<idShort>Rule_1</idShort>
<value>
<property><idShort>targetSubmodel</idShort><valueType>xs:string</valueType><value>CPS-SM</value></property>
<property><idShort>targetElement</idShort><valueType>xs:string</valueType><value>Temperature</value></property>
<property><idShort>condition</idShort><valueType>xs:string</valueType><value>greater_than</value></property>
<property><idShort>threshold</idShort><valueType>xs:string</valueType><value>85.0</value></property>
<property><idShort>action</idShort><valueType>xs:string</valueType><value>cooling-service</value></property>
</value>
</submodelElementCollection>
</submodelElements></submodel></submodels></environment>"""

CONFIG = {"machineId": "molder-9", "machineType": "Molder", "protocol": "OPC_UA",
          "connection": {"endpoint": "opc.tcp://localhost:4841"},
          "mappings": [{"sourceAddress": "ns=2;i=1", "idShort": "Temperature", "valueType": "xs:double"}]}


def make_aasx(path: Path, xml: str = RULES_XML) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("aasx/MachineTool-AAS/MachineTool-AAS.aas.xml", xml)


class AasxRuleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "MachineTool.aasx"; make_aasx(self.path)
        self.rules = module.AasxRules(self.path)

    def test_list_add_update_delete(self):
        self.assertEqual([r["id"] for r in self.rules.rules()], ["Rule_1"])
        added = self.rules.add({"targetElement": "Pressure", "condition": ">", "threshold": "120", "action": "svc", "description": "a < b & c"})
        self.assertEqual(added["id"], "Rule_2")
        self.assertEqual(added["condition"], "greater_than")  # symbol -> engine keyword, as in the CLI
        rule = self.rules.rules()[1]
        self.assertEqual(rule["description"], "a < b & c")
        changed = self.rules.update("Rule_2", {"threshold": "130", "cooldownMs": "5000"})
        self.assertEqual(changed["changed"][0]["old"], "120")
        self.assertIsNone(changed["changed"][1]["old"])  # property added to the rule
        self.assertEqual(self.rules.rules()[1]["cooldownMs"], "5000")
        self.rules.delete("Rule_1")
        self.assertEqual([r["id"] for r in self.rules.rules()], ["Rule_2"])
        with zipfile.ZipFile(self.path) as archive:
            self.assertIsNone(archive.testzip())
            self.assertIn("[Content_Types].xml", archive.namelist())

    def test_add_into_empty_rules_submodel(self):
        make_aasx(self.path, "<x><idShort>Rules-SM</idShort><submodelElements></submodelElements></x>")
        self.assertEqual(self.rules.add({"targetElement": "T", "condition": "less_than", "threshold": "1", "action": "s"})["id"], "Rule_1")
        self.assertEqual(len(self.rules.rules()), 1)

    def test_rejects_bad_input(self):
        with self.assertRaises(HTTPException): self.rules.add({"targetElement": "T", "condition": "between", "threshold": "1", "action": "s"})
        with self.assertRaises(HTTPException): self.rules.add({"targetElement": "T"})
        with self.assertRaises(HTTPException) as missing: self.rules.update("Rule_7", {"threshold": "1"})
        self.assertEqual(missing.exception.status_code, 404)

    def test_backup_and_verify(self):
        backup = self.rules.backup()
        self.assertTrue((self.path.parent / backup["backup"]).is_file())
        self.assertEqual(self.rules.verify()["problems"], [])

    def test_eval_condition(self):
        self.assertTrue(module.eval_condition("90", "greater_than", "85"))
        self.assertFalse(module.eval_condition("80", "greater_than", "85"))
        self.assertTrue(module.eval_condition("0.5", "out_of_bounds", "-0.45,0.45"))
        self.assertTrue(module.eval_condition("on", "equals", "on"))


class ConfigValidationTests(unittest.TestCase):
    def test_valid_and_duplicate(self):
        self.assertEqual(module.validate_config(CONFIG, set()), ([], []))
        self.assertIn("already in use", module.validate_config(CONFIG, {"molder-9"})[0][0])

    def test_plain_password_rejected_placeholder_accepted(self):
        doc = json.loads(json.dumps(CONFIG)); doc["connection"]["password"] = "secret"
        self.assertTrue(any("DT_MOLDER_9_PASSWORD" in e for e in module.validate_config(doc, set())[0]))
        doc["connection"]["password"] = "${DT_MOLDER_9_PASSWORD}"
        self.assertEqual(module.validate_config(doc, set())[0], [])

    def test_unknown_keys_are_warnings(self):
        doc = {**CONFIG, "typo": 1}
        errors, warnings = module.validate_config(doc, set())
        self.assertEqual(errors, []); self.assertTrue(warnings)

    def test_credential_names(self):
        self.assertEqual(module.credential_env_names("molder-2"), ("DT_MOLDER_2_USERNAME", "DT_MOLDER_2_PASSWORD"))


@unittest.skipIf(os.name == "nt", "uses a POSIX shell script as fake Maven")
class StackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        for name in ("engine", "gateway", "runtime/service-manager-app"):
            (root / name).mkdir(parents=True)
        make_aasx(root / "MachineTool.aasx")
        self.mvn = root / "mvn.sh"
        self.mvn.write_text('#!/bin/sh\necho "args $@ config=$DT_FRAMEWORK_CONFIGPATH"\ncase "$*" in *spring-boot:run*) exec sleep 30;; esac\nexit 0\n')
        self.mvn.chmod(0o755)
        os.environ["MAVEN_CMD"] = str(self.mvn); self.addCleanup(os.environ.pop, "MAVEN_CMD", None)
        self.stack = module.Stack(engine_dir=root / "engine", gateway_dir=root / "gateway", runtime_dir=root / "runtime",
                                  engine_url="http://127.0.0.1:59080", gateway_health_url="http://127.0.0.1:59085/api/submodel/health",
                                  services_url="http://127.0.0.1:59082", gateway_config_dir=root / "gateway/configs",
                                  aasx_path=root / "MachineTool.aasx", state_dir=root / "state")

    def test_install_config_into_gateway_project(self):
        result = self.stack.install(CONFIG)
        self.assertEqual(result["installed"], "molder-9.json")
        self.assertEqual(self.stack.config_entries()[0]["machineId"], "molder-9")
        with self.assertRaises(HTTPException): self.stack.install(CONFIG)  # duplicate machineId
        self.assertEqual(self.stack.install(CONFIG, replace=True)["installed"], "molder-9.json")

    def test_create_from_browse_uses_placeholders(self):
        result = self.stack.create_from_browse({"machineId": "m-1", "protocol": "MQTT", "endpoint": "tcp://h:1883", "withCredentials": True,
                                                "mappings": [{"sourceAddress": "a/b", "idShort": "B", "valueType": "xs:int"}]})
        self.assertEqual(result["credentialVariables"], ["DT_M_1_USERNAME", "DT_M_1_PASSWORD"])
        saved = json.loads((Path(self.temp.name) / "gateway/configs/m-1.json").read_text())
        self.assertEqual(saved["connection"]["password"], "${DT_M_1_PASSWORD}")
        self.assertEqual([c["name"] for c in self.stack.credential_status()], ["DT_M_1_PASSWORD", "DT_M_1_USERNAME"])

    def test_build_run_stop(self):
        gateway = self.stack.component("gateway")
        gateway.start()
        for _ in range(40):
            if gateway.status()["phase"] == "starting" and gateway.proc and gateway.proc.poll() is None and gateway.marker.exists(): break
            time.sleep(0.1)
        status = gateway.status()
        self.assertTrue(status["tracked"]); self.assertTrue(status["built"])
        log = gateway.logs(50)
        self.assertIn("-DskipTests install", log); self.assertIn("config=file:", log)
        self.assertEqual(gateway.stop()["phase"], "stopped")
        self.assertFalse(gateway.status()["tracked"])


class PluginProjectAndExplorerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.project = root / "plugins" / "my-mqtt-plugin"
        module = self.project / "mqtt-adapter"
        (module / module_imports()).parent.mkdir(parents=True)
        (self.project / "pom.xml").write_text("<project/>"); (module / "pom.xml").write_text("<project/>")
        (module / module_imports()).write_text("com.example.mqtt.MqttAdapterAutoConfiguration\n")
        (root / "plugins" / "not-a-plugin").mkdir()
        for name in ("engine", "gateway", "runtime"):
            (root / name).mkdir()
        self.stack = module_stack(root)

    def test_inspect_folder_and_folder_listing(self):
        info = self.stack.plugins.inspect(str(self.project))
        self.assertEqual((info["protocol"], info["projectName"], info["modules"]), ("MQTT", "my-mqtt-plugin", ["mqtt-adapter"]))
        listing = self.stack.plugins.list_dirs(str(self.project.parent))
        self.assertEqual({d["name"]: d["plugin"] for d in listing["dirs"]}, {"my-mqtt-plugin": "MQTT", "not-a-plugin": None})
        with self.assertRaises(HTTPException) as no_plugin: self.stack.plugins.inspect(str(self.project.parent / "not-a-plugin"))
        self.assertEqual(no_plugin.exception.status_code, 422)
        with self.assertRaises(HTTPException) as missing: self.stack.plugins.inspect(str(self.project / "nope"))
        self.assertEqual(missing.exception.status_code, 404)

    def test_mqtt_topics_become_a_tree(self):
        session = object.__new__(module.MqttExplorerSession)
        session.lock = __import__("threading").Lock()
        session.topics = {"factory/m1/Temp": {"count": 2, "value": "42.5", "valueType": "xs:double", "updatedAt": 1.0, "retained": True},
                          "factory/m1": {"count": 1, "value": "on", "valueType": "xs:string", "updatedAt": 1.0, "retained": False},
                          "factory/m2/State": {"count": 1, "value": "RUN", "valueType": "xs:string", "updatedAt": 1.0, "retained": True}}
        tree = session.tree()
        factory = tree[0]
        self.assertEqual(factory["name"], "factory"); self.assertNotIn("address", factory)
        m1 = next(n for n in factory["children"] if n["name"] == "m1")
        self.assertEqual(m1["address"], "factory/m1")  # a topic can be a leaf and a branch
        self.assertEqual(m1["children"][0]["address"], "factory/m1/Temp")

    def test_explorer_rejects_unknown_protocols(self):
        with self.assertRaises(HTTPException): self.stack.explorer.start({"protocol": "DDS", "endpoint": "x"})
        with self.assertRaises(HTTPException): self.stack.explorer.start({"protocol": "MQTT", "endpoint": ""})


class ServicePackagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ("engine", "gateway", "runtime"):
            (self.root / name).mkdir()
        self.stack = module_stack(self.root)
        self.uploads = []
        self.stack.upload_to_engine = lambda name, content: self.uploads.append((name, base64.b64decode(content).decode())) or f"services/{name}"

    def run_job(self, **payload):
        job = {"log": str(self.root / "job.log"), "step": ""}
        Path(job["log"]).write_text("")
        return self.stack.packager._prepare(job, payload)

    def test_lua_folder_is_bundled_with_modules(self):
        folder = self.root / "calc"; (folder / "lib").mkdir(parents=True)
        (folder / "main.lua").write_text('local u = require("lib.util")\nreturn u.x')
        (folder / "lib" / "util.lua").write_text("return {x = 1}")
        text, entry, modules = module.bundle_lua(folder)
        self.assertEqual((entry, modules), ("main.lua", ["lib.util"]))
        self.assertIn('__labradt_modules["lib.util"]', text); self.assertTrue(text.rstrip().endswith("return u.x"))
        result = self.run_job(runtimeType="LUA", value=str(folder), serviceId="Calc Service")
        self.assertEqual(result["fileReference"], "services/calc-service.lua")
        with self.assertRaises(ValueError):
            (folder / "main.lua").unlink(); (folder / "other.lua").write_text("return 2"); module.bundle_lua(folder)

    def test_values_that_are_no_local_path_are_kept(self):
        for runtime, value in (("REST", "https://x/api"), ("LUA", "services/existing.lua"), ("MYPLUGIN", str(self.root)), ("CONTAINER", "nginx:latest")):
            self.assertEqual(self.run_job(runtimeType=runtime, value=value)["action"], "keep", (runtime, value))
        self.assertEqual(self.uploads, [])

    def test_container_and_python_folders_become_images(self):
        fake = self.root / "docker.sh"; fake.write_text('#!/bin/sh\ncase "$1" in load) echo "Loaded image: demo/x:1";; esac\nexit 0\n'); fake.chmod(0o755)
        os.environ["DOCKER_CMD"] = str(fake); self.addCleanup(os.environ.pop, "DOCKER_CMD", None)
        box = self.root / "box"; box.mkdir(); (box / "Dockerfile").write_text("FROM alpine")
        self.assertEqual(self.run_job(runtimeType="CONTAINER", value=str(box), serviceId="Box")["defaultArgs"], {"image": "labradt/box:latest"})
        archive = self.root / "img.tar"; archive.write_text("x")
        self.assertEqual(self.run_job(runtimeType="CONTAINER", value=str(archive))["defaultArgs"], {"image": "demo/x:1"})
        app = self.root / "app"; app.mkdir(); (app / "main.py").write_text("print(1)"); (app / "requirements.txt").write_text("requests")
        with self.assertRaises(RuntimeError):  # Python needs the Docker (or a Python) runtime plugin
            self.run_job(runtimeType="PYTHON", value=str(app))
        (self.stack.state_dir / "runtime-plugins" / "docker").mkdir(parents=True)
        (self.stack.state_dir / "runtime-plugins" / "docker" / "plugin.json").write_text(json.dumps({"key": "docker", "id": "runtime:DOCKER", "adapter": "DOCKER"}))
        result = self.run_job(runtimeType="PYTHON", value=str(app), serviceId="app")
        self.assertEqual((result["category"], result["adapter"], result["defaultArgs"]["image"]), ("CONTAINER", "DOCKER", "labradt/app:latest"))
        self.assertIn("pip install", (self.stack.state_dir / "service-builds" / "app" / "Dockerfile").read_text())

    def test_runtime_plugin_detection(self):
        plugin = self.root / "my-lua-plugin"; src = plugin / "src/main/java/x"; src.mkdir(parents=True)
        (plugin / "pom.xml").write_text("<project><parent><artifactId>runtime-parent</artifactId></parent><artifactId>runtime-lua</artifactId><dependencies><dependency><artifactId>runtime-script</artifactId></dependency></dependencies></project>")
        (src / "LuaInterpreter.java").write_text("class LuaInterpreter implements IScriptInterpreter { TechnologyAdapter t() { return TechnologyAdapter.LUA; } }")
        info = self.stack.runtime_plugins.inspect(str(plugin))
        self.assertEqual((info["adapter"], info["category"], info["artifact"]), ("LUA", "SCRIPT", "runtime-lua"))
        core = self.root / "runtime-core"; core.mkdir(); (core / "pom.xml").write_text("<project><modules><module>core-api</module></modules><artifactId>core-api</artifactId></project>")
        with self.assertRaises(HTTPException): self.stack.runtime_plugins.inspect(str(core))
        self.assertEqual(self.stack.runtime_env(), {"RUNTIME_SEED_ENABLED": "false"})

    def install_fake_runner(self, adapter, category):
        home = self.stack.state_dir / "runtime-plugins" / adapter.lower(); home.mkdir(parents=True, exist_ok=True)
        (home / "plugin.json").write_text(json.dumps({"key": adapter.lower(), "id": "runtime:" + adapter, "adapter": adapter, "category": category}))

    def test_python_runner_stores_scripts_and_packs_folders(self):
        import subprocess
        self.install_fake_runner("PYTHON", "SCRIPT")
        app = self.root / "app"; app.mkdir(); (app / "main.py").write_text("print('one')")
        result = self.run_job(runtimeType="PYTHON", value=str(app), serviceId="app")
        self.assertEqual((result["fileReference"], self.uploads[-1][1]), ("services/app.py", "print('one')"))
        (app / "helpers").mkdir(); (app / "helpers" / "__init__.py").write_text(""); (app / "helpers" / "calc.py").write_text("def twice(x):\n    return 2 * x\n")
        (app / "main.py").write_text("import os\nfrom helpers.calc import twice\nprint(twice(int(os.environ['X'])))\n")
        (app / "__pycache__").mkdir(); (app / "__pycache__" / "junk.pyc").write_bytes(b"x")
        result = self.run_job(runtimeType="PYTHON", value=str(app), serviceId="app")
        self.assertEqual((result["category"], result["adapter"]), ("SCRIPT", "PYTHON"))
        stored = self.uploads[-1][1]
        self.assertTrue(stored.startswith(module.PYTHON_PACK_HEADER + "\n"))
        pyz = self.root / "app.pyz"; pyz.write_bytes(base64.b64decode(stored.split("\n", 1)[1]))
        self.assertNotIn("__pycache__/junk.pyc", zipfile.ZipFile(pyz).namelist())
        out = subprocess.run([sys.executable, str(pyz)], env={**os.environ, "X": "21"}, capture_output=True, text=True)
        self.assertEqual(out.stdout.strip(), "42", out.stderr)
        script = self.root / "solo.py"; script.write_text("print(2)")
        self.assertEqual(self.run_job(runtimeType="PYTHON", value=str(script))["fileReference"], "services/solo.py")

    def test_script_runner_from_a_plugin_takes_one_file(self):
        self.install_fake_runner("RUBY", "SCRIPT")
        script = self.root / "hello.rb"; script.write_text("puts 1")
        self.assertEqual(self.run_job(runtimeType="RUBY", value=str(script))["fileReference"], "services/hello.rb")
        with self.assertRaises(RuntimeError):
            self.run_job(runtimeType="RUBY", value=str(self.root))

    def test_plugin_browsers_open_at_the_plugin_folders_next_to_the_projects(self):
        self.assertEqual(self.stack.runtime_plugins.start_folder(), str(Path.home()))
        (self.root / "runtime-plugins").mkdir(); (self.root / "gateway-implementations").mkdir()
        self.assertEqual(self.stack.runtime_plugins.start_folder(), str((self.root / "runtime-plugins").resolve()))
        self.assertEqual(self.stack.plugins.start_folder(), str((self.root / "gateway-implementations").resolve()))
        os.environ["LABRADT_RUNTIME_PLUGINS_DIR"] = str(self.root / "engine"); self.addCleanup(os.environ.pop, "LABRADT_RUNTIME_PLUGINS_DIR", None)
        self.assertEqual(self.stack.runtime_plugins.start_folder(), str((self.root / "engine").resolve()))

    def test_runner_project_defining_a_new_language(self):
        plugin = self.root / "ruby-runner"; src = plugin / "src/main/java/x"; src.mkdir(parents=True)
        (plugin / "pom.xml").write_text("<project><artifactId>runtime-ruby</artifactId><dependencies><dependency><artifactId>runtime-script</artifactId></dependency></dependencies></project>")
        (src / "RubyInterpreter.java").write_text('class RubyInterpreter implements IScriptInterpreter {\n'
            '  public static final TechnologyAdapter RUBY = TechnologyAdapter.define("RUBY", ExecutionCategory.SCRIPT);\n'
            '  public TechnologyAdapter getScriptType() { return RUBY; } }')
        info = self.stack.runtime_plugins.inspect(str(plugin))
        self.assertEqual((info["adapter"], info["category"], info["technology"], info["kind"]), ("RUBY", "SCRIPT", "SCRIPT/RUBY", "project"))
        listing = self.stack.runtime_plugins.list_dirs(str(self.root))
        self.assertIn("RUBY", [d["plugin"] for d in listing["dirs"]])

    def test_runner_jar_is_read_from_its_bytecode_and_installed(self):
        import subprocess
        javac = shutil.which("javac")
        if not javac:
            self.skipTest("no JDK")
        src = self.root / "src"
        files = {
            "de/labradt/serviceexecution/core/api/enums/ExecutionCategory.java": "package de.labradt.serviceexecution.core.api.enums; public enum ExecutionCategory { SCRIPT, CONTAINER, EXTERNAL }",
            "de/labradt/serviceexecution/core/api/enums/TechnologyAdapter.java": "package de.labradt.serviceexecution.core.api.enums; public final class TechnologyAdapter { public static final TechnologyAdapter LUA = define(\"LUA\", ExecutionCategory.SCRIPT); public static TechnologyAdapter define(String n, ExecutionCategory c) { return new TechnologyAdapter(); } }",
            "de/labradt/serviceexecution/runtime/script/interpreter/IScriptInterpreter.java": "package de.labradt.serviceexecution.runtime.script.interpreter; import de.labradt.serviceexecution.core.api.enums.*; public interface IScriptInterpreter { TechnologyAdapter getScriptType(); }",
            "my/ruby/RubyInterpreter.java": "package my.ruby; import de.labradt.serviceexecution.core.api.enums.*; import de.labradt.serviceexecution.runtime.script.interpreter.IScriptInterpreter;"
                " public class RubyInterpreter implements IScriptInterpreter { public static final TechnologyAdapter RUBY = TechnologyAdapter.define(\"Ruby\", ExecutionCategory.SCRIPT); public TechnologyAdapter getScriptType() { return RUBY; } }",
            "my/lua/OtherLua.java": "package my.lua; import de.labradt.serviceexecution.core.api.enums.*; import de.labradt.serviceexecution.runtime.script.interpreter.IScriptInterpreter;"
                " public class OtherLua implements IScriptInterpreter { public TechnologyAdapter getScriptType() { return TechnologyAdapter.LUA; } }",
        }
        for name, text in files.items():
            (src / name).parent.mkdir(parents=True, exist_ok=True); (src / name).write_text(text)
        classes = self.root / "classes"
        subprocess.run([javac, "-d", str(classes)] + [str(src / n) for n in files], check=True, capture_output=True)
        def jar(name, prefix, extra=None):
            path = self.root / name
            with zipfile.ZipFile(path, "w") as archive:
                for c in classes.rglob("*.class"):
                    rel = c.relative_to(classes).as_posix()
                    if rel.startswith(prefix):
                        archive.write(c, rel)
                for entry, text in (extra or {}).items():
                    archive.writestr(entry, text)
            return path
        ruby = jar("runtime-ruby-1.2.jar", "my/ruby", {"META-INF/maven/my/runtime-ruby/pom.properties": "groupId=my\nartifactId=runtime-ruby\nversion=1.2\n"})
        info = self.stack.runtime_plugins.inspect(str(ruby))
        self.assertEqual((info["adapter"], info["category"], info["kind"], info["key"]), ("RUBY", "SCRIPT", "jar", "runtime-ruby"))
        self.assertEqual(info["maven"]["groupId"], "my")
        self.assertEqual(self.stack.runtime_plugins.inspect(str(jar("lua.jar", "my/lua")))["adapter"], "LUA")
        with self.assertRaises(HTTPException):
            self.stack.runtime_plugins.inspect(str(jar("api.jar", "de/")))  # interfaces only: no runner
        with self.assertRaises(HTTPException):
            self.stack.runtime_plugins.inspect(str(jar("app.jar", "my/ruby", {"BOOT-INF/classes/x": "x"})))
        self.assertIn("runtime-ruby-1.2.jar", [j["name"] for j in self.stack.runtime_plugins.list_dirs(str(self.root))["jars"]])
        uploaded = self.stack.runtime_plugins.save_upload("lua.jar", base64.b64encode((self.root / "lua.jar").read_bytes()).decode())
        self.assertEqual((uploaded["adapter"], uploaded["kind"]), ("LUA", "jar"))
        with self.assertRaises(HTTPException):
            self.stack.runtime_plugins.save_upload("notes.txt", "eA==")
        self.stack.runtime_plugins.install(uploaded["path"])
        for _ in range(100):
            if self.stack.runtime_plugins.job["state"] != "running": break
            time.sleep(0.05)
        self.assertEqual(self.stack.runtime_plugins.job["state"], "done", self.stack.runtime_plugins.job)
        installed = self.stack.runtime_plugins.catalogue_entries()
        self.assertEqual([(p["technology"], p["kind"], p["jars"]) for p in installed], [("SCRIPT/LUA", "jar", ["lua.jar"])])
        self.assertFalse(Path(uploaded["path"]).exists())
        with self.assertRaises(HTTPException):
            self.stack.runtime_plugins.uninstall("runtime:LUA", ["svc-1"])


def module_imports():
    return module.AUTOCONFIG_IMPORTS


class ProjectHandOverAndArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.make_projects(self.root)
        self.stack = module_stack(self.root)
        self.stack.aasx = module.AasxRules(self.root / "engine/src/main/resources/MachineTool.aasx")

    @staticmethod
    def make_projects(root, engine="engine", gateway="gateway", runtime="runtime"):
        (root / engine / "src/main/resources").mkdir(parents=True, exist_ok=True)
        (root / engine / "pom.xml").write_text("<project><artifactId>dt-engine</artifactId></project>")
        make_aasx(root / engine / "src/main/resources/MachineTool.aasx")
        (root / gateway / "dt-gateway-app").mkdir(parents=True, exist_ok=True)
        (root / gateway / "pom.xml").write_text("<project/>"); (root / gateway / "dt-gateway-app/pom.xml").write_text("<project/>")
        (root / runtime / "service-manager-app").mkdir(parents=True, exist_ok=True)
        (root / runtime / "pom.xml").write_text("<project/>"); (root / runtime / "service-manager-app/pom.xml").write_text("<project/>")

    def install_plugin(self, store, key, extra=None):
        home = store.store / key; (home / "lib").mkdir(parents=True)
        (home / "lib" / f"{key}.jar").write_bytes(b"jar-" + key.encode())
        (home / "plugin.json").write_text(json.dumps({"key": key, "id": "x:" + key, "name": key, "jars": [f"{key}.jar"], "installedAt": 1, **(extra or {})}))

    def test_projects_are_detected_and_switched(self):
        self.assertEqual([module.detect_project(self.root / n) for n in ("engine", "gateway", "runtime", "state")], ["engine", "gateway", "runtime", None])
        other = self.root / "elsewhere"; self.make_projects(other)
        result = self.stack.set_projects({"gateway": str(other / "gateway"), "engine": str(other / "engine")})
        self.assertEqual(result["changed"], ["engine", "gateway"])
        self.assertEqual(self.stack.components["gateway"].project, (other / "gateway").resolve())
        self.assertEqual(self.stack.config_dir, (other / "gateway").resolve() / "dt-gateway-app/src/main/resources/configs")
        self.assertEqual(self.stack.aasx.path, (other / "engine").resolve() / "src/main/resources/MachineTool.aasx")
        self.assertEqual(json.loads((self.stack.state_dir / "projects.json").read_text())["gateway"], str((other / "gateway").resolve()))
        seen = []; self.stack.project_listeners.append(lambda s: seen.append(s.config_dir))
        self.stack.set_projects({"runtime": str(other / "runtime")}); self.assertEqual(len(seen), 1)
        with self.assertRaises(HTTPException) as wrong:
            self.stack.set_projects({"engine": str(other / "gateway")})
        self.assertIn("Gateway project", str(wrong.exception.detail))
        listing = self.stack.list_project_dirs(str(other))
        self.assertEqual({d["name"]: d["project"] for d in listing["dirs"]}, {"engine": "engine", "gateway": "gateway", "runtime": "runtime"})

    def test_plugins_are_written_into_the_projects_and_removed_again(self):
        self.install_plugin(self.stack.plugins, "mqtt-plugin", {"protocol": "MQTT"})
        self.install_plugin(self.stack.runtime_plugins, "runtime-python", {"adapter": "PYTHON", "category": "SCRIPT"})
        own = self.root / "gateway/plugins/my-own"; own.mkdir(parents=True); (own / "x.jar").write_bytes(b"mine")
        result = self.stack.apply_all()
        self.assertEqual((result["gateway"]["plugins"], result["runtime"]["plugins"]), (["mqtt-plugin"], ["runtime-python"]))
        self.assertTrue((self.root / "gateway/plugins/mqtt-plugin/mqtt-plugin.jar").is_file())
        self.assertIn("dt.adapter.mqtt.enabled=true", (self.root / "gateway/plugins/labradt-plugins.properties").read_text())
        self.assertTrue((self.root / "runtime/plugins/runtime-python/runtime-python.jar").is_file())
        self.assertEqual(self.stack.projects_info()["gateway"]["plugins"], ["mqtt-plugin", "my-own"])
        self.stack.plugins.uninstall("x:mqtt-plugin", [])
        self.assertFalse((self.root / "gateway/plugins/mqtt-plugin").exists())
        self.assertFalse((self.root / "gateway/plugins/labradt-plugins.properties").exists())
        self.assertTrue((own / "x.jar").is_file())  # folders not written by the UI stay
        self.assertEqual(self.stack.runtime_run_args(), ["spring-boot:run"])
        self.assertNotIn("additional-classpath", " ".join(self.stack.gateway_run_args()))

    def fake_repository(self, store, written):
        return {"collection": lambda kind: store[kind], "put": lambda kind, model: written.append((kind, model["id"])),
                "delete": lambda kind, identifier: written.append(("delete", identifier)), "reachable": lambda: True}

    def test_export_and_import_restore_a_project(self):
        from backend.project_archive import ProjectArchive
        from backend.project_model import EngineAasx, ServiceCatalog
        repo = {"shells": [{"id": "urn:shell", "idShort": "S", "assetInformation": {}}], "submodels": [{"id": "urn:sm", "idShort": "SM"}], "concept-descriptions": []}
        written = []
        store = self.root / "state/backend-config.json"; store.parent.mkdir(parents=True, exist_ok=True)
        store.write_text(json.dumps({"revision": 3, "bindings": [], "events": []}))
        catalog = ServiceCatalog(self.stack, self.root / "state/snap.json")
        archive = ProjectArchive(self.stack, store, EngineAasx(self.stack, self.fake_repository(repo, written)), catalog)
        self.stack.config_dir.mkdir(parents=True); (self.stack.config_dir / "molder.json").write_text(json.dumps(CONFIG))
        (self.root / "engine/storage/services").mkdir(parents=True); (self.root / "engine/storage/services/abc-calc.json").write_text("return 1")
        catalog.upsert({"serviceId": "calc", "executionCategory": "SCRIPT", "technologyAdapter": "LUA", "fileReference": "services/abc-calc"})
        self.install_plugin(self.stack.runtime_plugins, "runtime-lua", {"adapter": "LUA", "category": "SCRIPT"})
        data, name = archive.export()  # adopts the repository's AAS into the engine AASX first
        self.assertTrue(name.endswith(".zip"))
        manifest = archive.inspect(data)
        self.assertEqual((manifest["contents"]["gatewayConfigs"], manifest["contents"]["services"], manifest["contents"]["serviceFiles"]), (1, 1, 1))
        self.assertEqual((manifest["contents"]["servicesFrom"], manifest["contents"]["aas"]["submodels"]), ("project", 1))

        target = self.root / "target"; self.make_projects(target)
        fresh = module_stack(self.root / "unused"); fresh.state_dir = self.root / "state2"
        fresh.set_projects({k: str(target / k) for k in ("engine", "gateway", "runtime")})
        fresh.plugins.store = fresh.state_dir / "gateway-plugins"; fresh.runtime_plugins.store = fresh.state_dir / "runtime-plugins"
        written2 = []
        importer = ProjectArchive(fresh, self.root / "state2/backend-config.json", EngineAasx(fresh, self.fake_repository({"shells": [], "submodels": [], "concept-descriptions": []}, written2)), ServiceCatalog(fresh, self.root / "state2/snap.json"))
        report = importer.import_(data)
        self.assertEqual((report["gatewayConfigs"], report["services"], report["serviceFiles"], report["runtimePlugins"]), (1, 1, 1, ["runtime-lua"]))
        self.assertTrue((target / "gateway/dt-gateway-app/src/main/resources/configs/molder.json").is_file())
        self.assertEqual((target / "engine/storage/services/abc-calc.json").read_text(), "return 1")
        seed = json.loads((target / "runtime/config/services.json").read_text())
        self.assertEqual((seed["replace"], seed["services"][0]["serviceId"]), (True, "calc"))
        self.assertTrue((target / "runtime/plugins/runtime-lua/runtime-lua.jar").is_file())
        self.assertEqual(json.loads((self.root / "state2/backend-config.json").read_text())["revision"], 3)
        self.assertEqual(EngineAasx(fresh).environment()["submodels"], [{"id": "urn:sm", "idShort": "SM"}])  # AAS travel in the AASX
        self.assertEqual(written2, [("submodels", "urn:sm"), ("shells", "urn:shell")])  # and are pushed to the repository
        with self.assertRaises(HTTPException):
            importer.inspect(b"not a zip")
        bad = io_zip({"labradt-project.json": json.dumps({"format": "labradt-project", "version": 1}), "../evil.txt": "x"})
        with self.assertRaises(HTTPException):
            importer.inspect(bad)


class ProjectFirstPersistenceTests(unittest.TestCase):
    """What the Services, Rules and AAS pages save lands in the projects, also with every component stopped."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        ProjectHandOverAndArchiveTests.make_projects(self.root)
        self.stack = module_stack(self.root)
        self.stack.aasx = module.AasxRules(self.root / "engine/src/main/resources/MachineTool.aasx")

    def test_services_are_kept_in_the_runtime_project_while_the_runtime_is_stopped(self):
        from backend.project_model import ServiceCatalog
        catalog = ServiceCatalog(self.stack, self.root / "state/snap.json")
        self.stack.catalog = catalog
        self.assertEqual(catalog.list(), ([], "project"))
        a = {"serviceId": "a", "executionCategory": "SCRIPT", "technologyAdapter": "LUA", "fileReference": "services/x-a"}
        self.assertEqual(catalog.upsert(a)["where"], "project")
        catalog.upsert({**a, "displayName": "A"})
        catalog.upsert({"serviceId": "b", "executionCategory": "EXTERNAL", "technologyAdapter": "REST", "defaultArgs": {"url": "http://x"}})
        seed = json.loads((self.root / "runtime/config/services.json").read_text())
        self.assertEqual((seed["replace"], [s["serviceId"] for s in seed["services"]]), (True, ["a", "b"]))
        self.assertEqual(catalog.get("a")["displayName"], "A")
        catalog.delete("b")
        self.assertEqual([s["serviceId"] for s in catalog.list()[0]], ["a"])
        with self.assertRaises(HTTPException):
            catalog.delete("b")
        # the System page registers through the same catalog, and service files go to the engine project's storage
        self.stack.register_service({"serviceId": "c", "executionCategory": "SCRIPT", "technologyAdapter": "LUA",
                                     "file": {"name": "c.lua", "content": base64.b64encode(b"return 3").decode()}})
        ref = catalog.get("c")["fileReference"]
        self.assertTrue(ref.startswith("services/") and ref.endswith("-c"))
        self.assertEqual((self.root / "engine/storage" / (ref + ".json")).read_text(), "return 3")
        result = self.stack.delete_service("c", force=True)
        self.assertEqual(result["storage"], "removed from the engine project")
        self.assertFalse((self.root / "engine/storage" / (ref + ".json")).exists())

    def test_aas_are_kept_in_the_engine_aasx_and_synced_with_the_repository(self):
        from backend.project_model import EngineAasx, JSON_PART
        live = {"on": False}
        repo = {"shells": [], "submodels": [{"id": "urn:cps", "idShort": "CPS_SM"}, {"id": "urn:remote", "idShort": "Remote"}], "concept-descriptions": []}
        written = []
        model = EngineAasx(self.stack, {"collection": lambda kind: repo[kind], "put": lambda kind, m: written.append(("put", m["id"])),
                                        "delete": lambda kind, i: written.append(("delete", i)), "reachable": lambda: live["on"]})
        model.put("submodels", {"id": "urn:sensors", "idShort": "Sensors"})
        model.put("shells", {"id": "urn:shell", "idShort": "Machine", "assetInformation": {},
                             "submodels": [{"keys": [{"type": "Submodel", "value": "urn:sensors"}]}, {"keys": [{"value": "urn:gone"}]}]})
        model.put("submodels", {"id": "urn:engine", "idShort": "Rules_SM"})  # Engine-owned: not stored here
        model.put("submodels", {"id": "urn:gone", "idShort": "Gone"})
        model.delete("submodels", "urn:gone", remember=True)
        env = model.environment()
        self.assertEqual([m["id"] for m in env["submodels"]], ["urn:sensors"])
        self.assertEqual(len(env["assetAdministrationShells"][0]["submodels"]), 1)  # reference detached
        with zipfile.ZipFile(self.root / "engine/src/main/resources/MachineTool.aasx") as archive:
            names = archive.namelist()
            self.assertIn(JSON_PART, names)
            self.assertIn(b'Extension="json"', archive.read("[Content_Types].xml"))
            self.assertIn("aasx/MachineTool-AAS/MachineTool-AAS.aas.xml", names)  # the Engine's part stays
        self.assertEqual(len(self.stack.aasx.rules()), 1)  # and its rules are untouched
        self.assertEqual(model.sync()["state"], "pending")
        live["on"] = True
        result = model.sync()
        self.assertEqual((result["pushed"], result["adopted"], result["removed"]), (2, 1, 1))
        self.assertIn(("delete", "urn:gone"), written)
        self.assertEqual(sorted(m["id"] for m in model.environment()["submodels"]), ["urn:remote", "urn:sensors"])  # CPS_SM not adopted
        self.assertEqual(model.read()["labradt"]["deleted"], [])

    def test_engine_capable_rules_page_rules_are_written_into_the_aasx(self):
        from backend.project_model import RulesPageSync
        submodels = {"urn:cps": {"id": "urn:cps", "idShort": "CPS_SM"}, "urn:other": {"id": "urn:other", "idShort": "Other"}}
        sync = RulesPageSync(self.stack, submodels.get)
        def rule(rid, operator=">", sm="urn:cps", path="Temperature", **extra):
            return {"id": rid, "name": "Rule " + rid, "enabled": True, "monitors": [{"propertyId": f"aas|{sm}|{path}", "condition": {"operator": operator, "right": {"value": "80"}}}],
                    "serviceCall": {"serviceId": "cooling", "bindings": {"level": {"source": "constant", "value": "high"}, "load": {"source": "property", "propertyId": "aas|urn:cps|Load"}}},
                    "output": {"kind": "none"}, **extra}
        marked = sync.sync([rule("r1"), rule("r2", operator=">="), rule("r3", sm="urn:other"), rule("r4", output={"kind": "aas_property", "propertyId": "x"})])
        self.assertEqual([(m["id"], m["executor"]) for m in marked], [("r1", "engine"), ("r2", "ui"), ("r3", "ui"), ("r4", "ui")])
        engine_rules = [r for r in self.stack.aasx.rules() if r.get("source", "").startswith("rules-page:")]
        self.assertEqual(len(engine_rules), 1)
        r = engine_rules[0]
        self.assertEqual((r["targetSubmodel"], r["targetElement"], r["condition"], r["threshold"], r["action"]), ("CPS_SM", "Temperature", "greater_than", "80", "cooling"))
        self.assertEqual(json.loads(r["parameters"]), {"level": "high", "load": {"input": "Load"}})
        self.assertEqual(marked[0]["engineRule"], r["id"])
        marked = sync.sync([rule("r1", operator="<")])  # edited: updated in place
        rules = [x for x in self.stack.aasx.rules() if x.get("source", "").startswith("rules-page:")]
        self.assertEqual([(x["id"], x["condition"]) for x in rules], [(r["id"], "less_than")])
        sync.sync([])  # deleted on the Rules page: removed from the AASX
        self.assertEqual([x for x in self.stack.aasx.rules() if x.get("source", "").startswith("rules-page:")], [])
        self.assertEqual(len(self.stack.aasx.rules()), 1)  # the AASX's own rule stays

    def test_file_chooser_opens_at_the_nearest_existing_folder(self):
        near = module.GatewayPluginProjects.nearest_folder
        folder = self.root / "engine"
        self.assertEqual(near(str(folder), "H"), str(folder))
        self.assertEqual(near(str(folder / "pom.xml"), "H"), str(folder))
        self.assertEqual(near(str(folder / "missing" / "main.lua"), "H"), str(folder))
        self.assertEqual((near("main.lua", "H"), near("", "H")), ("H", "H"))
        listing = self.stack.plugins.list_entries(str(folder / "missing.lua"), [".lua"])
        self.assertEqual(listing["path"], str(folder.resolve()))


def io_zip(entries):
    import io
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, text in entries.items():
            archive.writestr(name, text)
    return buffer.getvalue()


def module_stack(root):
    return module.Stack(engine_dir=root / "engine", gateway_dir=root / "gateway", runtime_dir=root / "runtime",
                        engine_url="http://127.0.0.1:59080", gateway_health_url="http://127.0.0.1:59085/api/submodel/health",
                        services_url="http://127.0.0.1:59082", gateway_config_dir=root / "gateway/configs",
                        aasx_path=root / "MachineTool.aasx", state_dir=root / "state")


if __name__ == "__main__":
    unittest.main()
