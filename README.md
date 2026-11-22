# LABraDT UI — configure and start the digital twin

| Component | Project folder (next to this folder) | Port |
|---|---|---|
| Runtime (Service Manager) | `runtime-labradt-framework` | 8082 |
| Gateway | `gateway-labradt-framework` | 8085 |
| Engine | `engine-labradt-framework` | 8080 |

## Quick start (Windows)

Requirements: Python 3.12, a JDK (`JAVA_HOME` or `java` on the `PATH`) and Maven (`mvn` on the
`PATH`, `MAVEN_CMD`, or the Maven wrapper of a project). The first start builds every project.
That needs the Maven repositories, so the first start takes some minutes.

```powershell
start-ui.bat            # creates .venv, installs requirements.txt, starts the UI
```

Then open <http://localhost:8090>, open **System**, check (or **Browse…** to) the three project folders and click **Start Stack**.
On Linux / macOS, use `./start-ui.sh`.

## Project folders, hand-over and export / import

**System → Project** shows the three component projects the UI configures and starts:

* **Engine (core-engine)**, **Gateway** and **Runtime**, each with **Browse…**. The folder
  browser marks which folders are an engine, gateway or runtime project, and only a matching
  folder can be chosen. The choice is saved in `runtime/projects.json` and used at the next UI
  start too. `LABRADT_ENGINE_DIR` / `LABRADT_GATEWAY_DIR` / `LABRADT_RUNTIME_DIR` still win if
  set. A component must be stopped to change its folder.
* **Everything configured is written into the projects:**
  * machine configs → `gateway/dt-gateway-app/src/main/resources/configs/`
  * rules → the engine's AASX (`src/main/resources/MachineTool.aasx`)
  * service files (scripts, Dockerfiles, packed folders) → `engine/storage/`
  * the service registry → the runtime project's own database
  * **Gateway plugins and runtimes → `<project>/plugins/<plugin>/`**, plus
    `plugins/labradt-plugins.properties` with the switches that enable the protocol adapters
  
  Plugins are written at every start of the component, after every plugin install / uninstall,
  and with **Apply to Projects**. Folders in `plugins/` that the UI did not write are left alone.
* **The projects run without the UI.** The gateway and runtime projects start through
  `PluginLauncher`, which loads every JAR below `plugins/`, so `mvn spring-boot:run` (or
  `java -jar`) picks the plugins up with no pom change. Set `LABRADT_PLUGINS_DIR` to use another
  folder.

**Every page saves into the projects, whether or not the components run.** A change goes live when the
component runs, and it is always kept in the project, so the System page and the projects show the same:

| Page | Kept in the project | Live, when running |
|---|---|---|
| Services | the runtime project's `config/services.json` while the Runtime is stopped (registered at its next start); service files in the engine project's `storage/` | the Service Manager's registry (its database is in the runtime project) and the Engine storage |
| Rules | rules the Engine can run go into Rules_SM of the engine AASX: one watched value of the Engine's data submodel `CPS_SM`, `>` `<` or `=`, constant or `CPS_SM` arguments, no output mapping. They are marked **Engine · Rule_n** on the Rules page and **Rules page** on the System page. Other rules are marked **UI only** with the reason, and the UI controller runs them. The Rules page also lists every other rule of the AASX (**Engine rules in the AASX**, e.g. the shipped Rule_1…Rule_3) with Edit, Enable / Disable and Delete, and the Overview counts them. | the Engine, after Initialize |
| AAS | the engine AASX, as an extra part `aasx/labradt/environment.json` beside the Engine's own XML | the AAS repository (port 8081). The project's AAS are written there on every change, at Start Stack and with Apply to Projects. AAS that exist only in the repository are taken into the AASX. |
| Gateway | `dt-gateway-app/src/main/resources/configs/` | the Gateway, after a restart |

The badges show which applies: on the Services page **Saved in runtime project** or **Live registry**, on the
AAS page **Saved in engine AASX** or **Repository + engine AASX**.

**Export Project** downloads one self-contained `.zip` with:

* the machine configs and the rules AASX
* the service definitions and their files
* the UI workspace (bindings, service metadata)
* the AAS (kept in the engine AASX)
* all installed plugin JARs

**Import Project** shows what the file contains, then writes it into the three folders chosen on
the System page. The stack must be stopped first.

* The previous configs, AASX, workspace and plugins are moved to
  `runtime/backups/before-import-<time>/`.
* Services go to the runtime project's `config/services.json`. The Runtime registers them at its
  next start, replacing its registry, and renames the file to `services.imported.json`.
* AAS come with the AASX. They are written to the repository as soon as it is reachable: at
  import, at Start Stack, or with **Apply to Projects**.

## Blank canvas

The UI starts empty:

* no Gateway plugins. The gateway project ships no protocol adapter; OPC UA, MQTT, … are
  separate plugins (**Add GW Plugin**). If your Gateway build has adapters compiled in, list
  them in `GATEWAY_BUNDLED_PROTOCOLS`, e.g. `OPC_UA,MQTT`.
* no Services, no AAS, no machine connections, no signal mappings, no Rules. There is no demo
  machine and no FiveX sample.
* no AAS seed packages in `data/repository/` (run `python -m scripts.prepare_aas` to create the
  MachineTool / Molder seeds for the Docker stack again).
* browser data has its own namespace (`labradt-ui:v1:`). Workspaces of earlier UIs on
  `localhost:8090` (e.g. the exhibition UI) are not loaded. UI files are served with
  `Cache-Control: no-cache`, so the browser never shows a cached older UI.

The AAS page shows what the AAS repository on port 8081 holds. If
AAS still appear there, a repository from another stack (e.g. the exhibition Docker stack) is
running. Stop that stack.

## Gateway plugins and MQTT

The Gateway page starts empty: no plugin, no machine connection. MQTT is the default protocol.

1. **Add GW Plugin → Plugin project folder.** Enter the folder of a protocol plugin project (for
   example the MQTT plugin with its modules `mqtt-adapter` and `mqtt-translator`), or pick it with
   **Browse…**. The folder browser marks plugin projects and remembers the last folder in the
   browser. **Check folder** shows the plugin. **Install** then does this:
   * it installs the gateway core into the local Maven repository (first time only);
   * it builds a staged copy of the plugin in `runtime/gateway-plugins/<project>/`. A plugin written
     against the former core package `com.guc.dt_framework` is built against
     `de.labradt:dt-gateway-framework` there;
   * it copies the plugin JARs and the dependencies the Gateway does not have yet (Eclipse Paho for
     MQTT) to `runtime/gateway-plugins/<project>/lib/`.

   Nothing depends on where the plugin project lies: no path is built in, and after the install the
   UI uses only its own copy. Neither the plugin project nor the gateway project is changed. At its
   next start the UI runs the Gateway with
   `-Dspring-boot.run.additional-classpath-elements=<those JARs>` and the plugin's switch
   (`DT_ADAPTER_MQTT_ENABLED=true`). The plugin then shows as **Loaded**.
2. **Add Machine Connection** asks for these fields:
   * Machine ID and machine type;
   * broker URL (`tcp://host:1883`);
   * optional topic filter (never `#`);
   * quiet window (ms);
   * broker authentication: Anonymous, or username / password from environment variables. The file
     stores only `${DT_<MACHINE>_USERNAME}` / `${DT_<MACHINE>_PASSWORD}`; enter the values on the
     System page under *Credential variables*.
3. **Explore Address Space** opens the generic tree explorer of the plugin's protocol:
   * **MQTT:** the explorer subscribes to the broker (topic filter, or `#` when empty) and stays
     subscribed. Topics form a tree at `/` and new topics appear as messages arrive; retained
     topics appear at once. Each topic shows its live value, type and age.
   * **OPC UA:** the explorer walks the address space below the Objects folder and shows each
     variable's node ID, type, value and write access.

   You can filter, expand and collapse the tree, and **Select all** below a branch. **Add** turns
   the picked leaves into Signal Mappings. The explorer runs in the UI controller
   (`/api/stack/explore`, one provider per protocol), so another plugin only needs a provider in
   `backend/stack.py`.
4. **Add Mapping** takes these fields:
   * topic, idShort, value type and unit;
   * category;
   * optional semantic ID and unit conversion;
   * limits and deadband (via *Set Limits*).
5. **Save to Gateway** writes `<gateway>/dt-gateway-app/src/main/resources/configs/<machine>.json`.
   Restart the Gateway on the System page. **Test Connection** checks the broker directly.

Payloads are the plugin's JSON envelope `{"value": …, "timestamp": …, "quality": "GOOD"}` or a bare
value. The plugin publishes writes retained with QoS 1.

With the Engine not running ("state zero") all pages stay editable. Configuration is locked only
while automatic execution runs. The Pipeline viewer is no longer linked in the sidebar
(`frontend/pipline.html` still exists).

## Runtimes (service plugins) and service instances

Two levels:

* **Runtimes** are the service plugins of the Runtime (Service Manager). Each runtime executes one **technology**: a fixed
  category, `SCRIPT`, `CONTAINER` or `EXTERNAL`, plus an adapter inside it, i.e. the language or
  tool, such as `SCRIPT / LUA`, `SCRIPT / PYTHON`, `CONTAINER / DOCKER` or `EXTERNAL / REST`. The
  categories never change. Plugins add new adapters, such as new languages.
* **The Service Registry holds service instances.** Each instance names the runtime it needs
  (category + adapter). The registry shows per instance whether that runtime is installed.

The Overview (Services card) and the top of the Services tab both list the runtimes grouped by
category, and both have **Add Service Plugin**. The dialog opens with a folder browser at `runtime-plugins` next to the runtime project (or `LABRADT_RUNTIME_PLUGINS_DIR`); **⌂ runtime-plugins** jumps back there. The runtimes offered when registering a service come only from installed
runtime plugins. A runtime can come from:

* **a plugin project folder** (with its `pom.xml`), e.g. `runtime-plugins/lua-runtime-plugins`,
  `python-runtime-plugins`, the Docker, REST and Bash plugins, or your own. **Browse…** marks
  plugin folders with their adapter. The UI builds a staged copy with Maven; the project itself
  is not changed.
* **a built plugin `.jar`**, chosen with **Browse…** (JAR files are listed) or sent with
  **Upload JAR…**. The UI reads the adapter and category from the class files. When the JAR
  carries Maven metadata (`META-INF/maven/…/pom.xml`, as every `mvn package` JAR does), it is
  registered in the local Maven repository and its dependencies are resolved. Otherwise it is
  installed alone and must bring its own dependencies. Executable Spring Boot JARs are rejected.

Then **Check** and **Install**, and restart the Runtime. The UI starts the Service Manager with
`-Dspring-boot.run.additional-classpath-elements=<plugin JARs>`, and the Service Manager finds the
runtime beans by component scan.

* A project or JAR counts as a runtime when it has a class that implements `IScriptInterpreter`,
  `IContainerOrchestrator` or `IExternalServiceClient` and returns a `TechnologyAdapter`. That
  can be a built-in one (`return TechnologyAdapter.LUA;`) or a new one defined by the plugin:

  ```java
  public static final TechnologyAdapter RUBY = TechnologyAdapter.define("RUBY", ExecutionCategory.SCRIPT);
  ```

  In the runtime core, `TechnologyAdapter` is an open enum, so the registry stores and routes
  adapters it does not know at compile time. `ExecutionCategory` stays a plain enum.
* There is one runtime per adapter. Uninstall is refused while service instances still use the
  runtime.
* Projects with the former `isw.digitaltwin` names are built against the renamed runtime
  (`de.labradt`).
* The UI starts the Runtime with `RUNTIME_SEED_ENABLED=false`, so the registry stays empty (no
  demo services).

**Register Service → File / Endpoint** accepts a file, a folder, a URL or any string.
**Browse…** lists files and folders on the computer running the UI. Folders that contain a
`Dockerfile`, `main.py` or `main.lua` are marked. On save, the UI prepares the value:

| Runtime | File / Endpoint | What happens |
|---|---|---|
| Lua | `.lua` script, or folder with `main.lua` / `init.lua` | The UI bundles the folder into one script: the other `.lua` files become modules for `require()`, because the runtime sandbox has no `require`. The script goes to the Engine storage. |
| Container | folder with `Dockerfile`, a `Dockerfile`, or an image archive `.tar` | Needs **Docker installed on this computer**. A folder is built with `docker build -t labradt/<service>:latest <folder>`, and the service runs that image (`defaultArgs.image`). An archive is loaded with `docker load`. A single Dockerfile is stored and built by the runtime. |
| Python (runtime `SCRIPT / PYTHON`) | `.py` script, or folder with `main.py` | With the Python runtime (`runtime-plugins/python-runtime-plugins`): a script is stored as is. A folder is packed as a zip application (its modules, packages and data plus a `__main__.py`, base64 text, up to 1 MB) and runs on the Runtime's Python. Packages from `requirements.txt` must be installed into that Python. |
| Python (via Docker runtime) | folder with `main.py` (optional `requirements.txt`) | Without the Python runtime but with the Docker runtime, it runs in a container: the UI generates a `python:3.12-slim` Dockerfile (unless the folder has one) and builds the image. Needs Docker. |
| other `SCRIPT` runtimes from plugins | one script file | Stored in the Engine storage and handed to the runtime. |
| REST | URL | Kept as entered. |
| other runtimes | anything | Kept exactly as entered (path, URL or string). |

Arguments always arrive as environment variables (Bash, Python) or script globals (Lua), and what
a script prints is its result. Scripts and Dockerfiles are stored in the Engine storage, so the
Engine must be running when you register them. The storage keeps text only, up to 1 MB per file. The Services page also works without an AAS
repository on port 8081: the Service Manager, the workspace and the AAS part now load
independently.

## `unified_cli.py` → UI

| CLI menu | UI (System page unless noted) |
|---|---|
| Integrator · Gateway · Install a ready config file | **Install Config File** (file or paste). Uses the CLI validation, including the rejection of plain-text passwords. Also installs the ready configs in `configs-*` folders. |
| Integrator · Gateway · Browse a live machine | **Browse Live Machine**: OPC UA (asyncua) or MQTT (paho-mqtt), pick signals, name / type / unit. Credentials become `${DT_<MACHINE>_USERNAME/PASSWORD}` placeholders. |
| (set credential variables before starting the gateway) | **Credential variables**: the values stay in the controller's memory and are passed to the Gateway process. They are never written to disk. |
| Integrator · Engine · List / Add / Set / Delete rule | **Engine · Rules in AASX**: table, **Add Rule**, **Edit**, **Delete** in `MachineTool.aasx`. Uses the same condition keywords (`greater_than`, `less_than`, `equals`, `out_of_bounds`). |
| Integrator · Engine · Verify / Backup AASX | **Verify AASX**, **Backup AASX** (`MachineTool_backup_<timestamp>.aasx`) |
| Integrator · Engine · Edit AASX in VS Code | Not needed for rules; the AASX page of the UI edits AAS content |
| Integrator · Service · Register / List / Delete | **Register Service** (script / Dockerfile upload to the Engine storage, default args), **Details**, **Delete**. Delete warns about rules that use the service and removes the storage file. |
| Integrator · Service · Nested services guide | **Nested Services**, plus a hint in the register dialog |
| Operator · Gateway / Engine · Start / Stop / Monitor | **Components**: Start, Stop, Force stop (for a process that was not started by the UI), Logs, health. **Start Stack** starts Runtime → Gateway → Engine and waits for each one. |
| Operator · Engine · Initialize / Shutdown / Status / History | **Engine · Operator**: Initialize, Shutdown, state badge, Transition History, Sensor Values |
| Operator · Service · Trigger / History / Status / Result / Stop | **Trigger** (one or more services, runs per service, dynamic args, live status), **Running** with Stop, **History** with Result, lookup by execution ID |

Configuration changes (machine configs, AASX rules, service registry) are refused while
automatic execution is running. Stop it in the top
bar first. Operator actions such as triggers stay available.

## Process control

For each project, the controller runs Maven in a supervised background process. The output goes
to `runtime/logs/<component>.log`.

| Component | Build (first start or *Build first*) | Run |
|---|---|---|
| runtime | `mvn -DskipTests install` | `mvn spring-boot:run` in `service-manager-app` |
| gateway | `mvn -DskipTests install` | `mvn -pl dt-gateway-app spring-boot:run` with `DT_FRAMEWORK_CONFIGPATH=file:<configs>/` |
| engine | `mvn -DskipTests install` | `mvn spring-boot:run` (the Engine initializes itself) |

**Stop** ends the whole process tree (`taskkill /T` on Windows, the process group on Linux /
macOS). A component that already answers on its port when the UI starts shows
**Running · external**. **Force stop** ends the process that listens on that port.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `LABRADT_ROOT` | parent of this folder | where the three project folders are |
| `LABRADT_ENGINE_DIR` / `LABRADT_GATEWAY_DIR` / `LABRADT_RUNTIME_DIR` | `../engine-labradt-framework` … (also `../engine`, `../gateway`, `../services`) | individual project folders |
| `LABRADT_AASX_PATH` | `<engine>/src/main/resources/MachineTool.aasx` | rules file |
| `GATEWAY_CONFIG_DIR` | `<gateway>/dt-gateway-app/src/main/resources/configs` | machine configs |
| `MAVEN_CMD` | Maven wrapper, `~/Tools/apache-maven-*`, `mvn` on the `PATH` | Maven executable |
| `LABRADT_MAVEN_ARGS` | – | extra Maven arguments, e.g. `-o` for offline |
| `LABRADT_START_TIMEOUT` | `420` | seconds that Start Stack waits for each component |
| `ENGINE_BASE_URL` / `SERVICES_BASE_URL` / `GATEWAY_HEALTH_URL` | `http://127.0.0.1:8080` / `:8082` / `:8085/api/submodel/health` | component URLs |
| `LABRADT_PLUGINS_DIR` (gateway / runtime project) | `plugins` or `../plugins` | folder the projects load plugin JARs from (`PluginLauncher`) |
| `LABRADT_GATEWAY_PLUGINS_DIR` | `../gateway-implementations` (else home) | where the Gateway plugin folder browser opens |
| `LABRADT_RUNTIME_PLUGINS_DIR` | `../runtime-plugins` (else home) | where the service plugin (runtime) folder browser opens |
| `GATEWAY_BUNDLED_PROTOCOLS` | – (empty) | protocol plugins compiled into the Gateway, shown as bundled |
| `UI_PORT` | `8090` | UI port |

OPC UA certificates prepared on the Gateway page go to `<gateway>/security`
(`GUC_OPCUA_SECURITY_DIR` changes this).

> **Check before you commit:** rule edits and installed configs change files in the engine and
> gateway project folders. Backups are written next to the AASX. Run `git status` in those
> folders before you commit.

## Tests

```powershell
.venv\Scripts\python -m unittest discover -s tests\python     # includes tests/python/test_stack.py
pnpm test                                                      # JS unit tests
```

`docker-compose.yml`, `deploy/` and `tools/` are unchanged from `ui-labradt-framework`. They still
describe the former containerized stack.

## Directory structure

```text
output/
├── app.py                      Python entry point (FastAPI controller, port 8090)
├── start-ui.bat / start-ui.sh  venv + requirements + start
├── backend/
│   ├── stack.py                NEW: process control and unified_cli.py tasks (/api/stack/*)
│   ├── settings.py             project folders of engine / gateway / runtime
│   └── …                       existing proxies, lifecycle, bindings, gateway management
├── frontend/
│   ├── index.html              + System page, stack strip, exhibition styles
│   ├── pipline.html            Pipeline viewer (exhibition styles)
│   └── assets/{css,js,images}/ + css/exhibition.css, css/stack.css, js/features/stack-control.js
├── config/ data/ deploy/ docs/ examples/ mock/ scripts/ tests/ tools/ diagrams/
└── requirements.txt, package.json
```
