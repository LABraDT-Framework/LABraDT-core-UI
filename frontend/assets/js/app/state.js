// Shared state. Loaded after function definitions, before bootstrap.js.
const environment = GucEnvironment;
const appStorage = environment.storage;
let aasItems = [];
const aasTemplateCatalog = GucAasTemplates.catalog();
let aasRepositoryMode = "aas";

let gatewayConfig = {
  machineId: "",
  machineType: "",
  protocol: "MQTT",
  endpoint: "",
  securityPolicy: "None",
  pollInterval: "2000 ms",
  reconnectInitialBackoffMs: 1000,
  reconnectMaxBackoffMs: 30000,
  topicFilter: "",
  quietWindowMs: 15000
};

let gatewayServerCertificates = [];

let mappings = [];

// Runtime types come only from installed runtimes (service plugins, features/service-plugins.js).
let serviceRuntimeTypes = {};

let services = [];

const sharedModel = window.gucModel = GucSharedModel.create(appStorage, environment.isBackend ? [] : services);
services = sharedModel.snapshot().services.map(normalizeService);
if (environment.isBackend) services = services.filter(service => service.status === "Backend");
if (JSON.stringify(services) !== JSON.stringify(sharedModel.snapshot().services)) sharedModel.replaceServices(services);

const toast = document.getElementById("toast");
const modalBackdrop = document.getElementById("modalBackdrop");
const modalTitle = document.getElementById("modalTitle");
const modalBody = document.getElementById("modalBody");
const modalForm = document.getElementById("modalForm");
const modalSubmit = document.getElementById("modalSubmit");
const modalCancel = document.getElementById("modalCancel");
let modalSubmitHandler = null;
let discoveredNodes = [];
let selectedAasId = aasItems[0]?.id || null;
let selectedServiceId = services[0]?.id || null;
const serviceExecutions = [];
let serviceRegistrySource = environment.isBackend ? "backend-cache" : "browser";
let serviceRegistryError = "";
let gatewayEditState = "loaded";


