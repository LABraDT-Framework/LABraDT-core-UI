# pipline viewer

The new **pipline** link sits below **Rules** and opens `/static/pipline.html` in a separate browser tab. The existing application's styles, scripts and workspaces are not loaded by this viewer or changed by it.

The viewer uses only existing GET endpoints and the Gateway's server-sent event stream. It cannot start/stop the runtime, execute a Service, modify configuration or send device commands. It does not write to the main application's browser storage. **Pause** pauses the viewer's requests and animation only. **Visual demo** uses clearly labelled synthetic data without contacting backend endpoints. The source choice belongs only to this page.

Backend mode observes Gateway properties (including observation timestamps), Engine health/runtime/rules, Service registry/running/history and Repository models. Existing completed executions form a baseline and do not replay as new activity. Interrupted components show unavailable states and are retried automatically. Metadata is read every 15 seconds, health every 5 seconds, and execution history every 3 seconds. A Gateway snapshot is used as a fallback when the event stream is disconnected.

This is an architectural activity overview, **not a packet capture**. A new Service execution record does not establish its caller. Existing APIs do not expose device-command or AAS-sync traffic, so those routes stay inactive in Backend mode. Repository changes are observations of model content, not proof of an Engine read. The timeline counts observed changes, not bytes or network packets.

Run the existing application normally, then open `http://localhost:8090/static/pipline.html`. For the visual demo open `http://localhost:8090/static/pipline.html?source=preview`. A standalone file preview also supports Visual demo; Backend mode needs the HTTP application.

For an existing Docker deployment, rebuild the UI image to include the new static files, keeping the existing Compose project name:

```powershell
docker compose -p ui_v09 up -d --build ui
```

The existing Dockerfile already copies all frontend files; no Compose or backend changes are needed for this feature.
