"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const BASE_URL = process.env.GUC_QA_BASE_URL || "http://localhost:8090";

const root = path.resolve(__dirname, "../../frontend");
const edge = process.env.GUC_BROWSER_EXECUTABLE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const screenshots = {
  tree: path.join(process.env.TEMP, "guc-engine-sme-tree.png"),
  modal: path.join(process.env.TEMP, "guc-engine-modal.png"),
  overview: path.join(process.env.TEMP, "guc-overview-aas-rules.png"),
  desktop: path.join(process.env.TEMP, "guc-rules-page-desktop.png")
};

const mime = file => ({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
})[path.extname(file).toLowerCase()] || "application/octet-stream";

(async () => {
  const browser = await chromium.launch({ executablePath: edge, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const pageErrors = [], consoleErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/Failed to load resource.*503/.test(message.text())) consoleErrors.push(message.text());
  });

  await page.route("http://guc.local/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/")) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "QA backend offline" }) });
      return;
    }
    const relative = decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname.startsWith("/static/assets/") ? "assets/" + url.pathname.slice("/static/assets/".length) : url.pathname.slice(1));
    const resolved = path.resolve(root, relative);
    if (!resolved.startsWith(root) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
      await route.fulfill({ status: 404, body: "Not found" });
      return;
    }
    await route.fulfill({ status: 200, contentType: mime(resolved), body: fs.readFileSync(resolved) });
  });

  await page.goto("http://guc.local/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("guc-ui-v0.9-environment", "demo"); });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('[data-nav="rules"]').waitFor();
  assert.equal(await page.title(), "The Rapid Application Development Toolkit for Digital Twins | LABraDT");
  assert.equal((await page.locator(".topbar h1").textContent()).trim(), "The Rapid Application Development Toolkit for Digital Twins");
  assert.equal((await page.locator(".brand-name").textContent()).trim(), "LABraDT");

  assert.equal(await page.getByRole("button", { name: /Link Service/i }).count(), 0);
  assert.equal(await page.locator("#overviewEngineCard").count(), 0);
  assert.equal(await page.locator("#overviewAasCard").count(), 1);
  assert.equal(await page.locator("#overviewRulesCard").count(), 1);
  assert.ok(await page.locator("#overviewAasList .overview-entity-row").count() > 0);
  assert.equal(await page.locator("#overviewRulesList .overview-entity-empty").count(), 1);
  await page.locator("#overviewAasList .overview-entity-row").first().click();
  await page.locator("#aasTab.active").waitFor();
  await page.locator('[data-nav="overview"]').click();
  await page.locator('[data-nav="rules"]').click();
  await page.locator("#rulesTab.active").waitFor();
  assert.equal(await page.locator("#rulesWorkflows .engine-empty").count(), 1);
  await page.locator("#addRule").click();
  const dialog = page.locator("dialog.service-link-dialog");
  await dialog.waitFor({ state: "visible" });
  assert.equal(await dialog.getByText("The workflow runs when", { exact: false }).count(), 0);
  assert.equal(await dialog.getByText("Rule Name", { exact: true }).count(), 1);
  assert.equal(await dialog.getByText("Service Trigger", { exact: true }).count(), 1);
  assert.equal(await dialog.getByText("TRUE", { exact: true }).count(), 0);
  assert.equal(await dialog.getByText("FALSE", { exact: true }).count(), 0);
  await dialog.locator('[name="ruleName"]').fill("Temperature Guard");

  await dialog.getByRole("button", { name: "Select Monitored SME 1" }).click();
  const propertyDialog = page.locator("dialog.engine-sme-dialog");
  await propertyDialog.waitFor({ state: "visible" });
  assert.ok(await propertyDialog.locator("details").count() >= 2, "SME picker should render AAS and Submodel levels");
  const numericLeaf = propertyDialog.locator('button[data-property-id]').filter({ hasText: /xs:(double|float|int|integer|long|decimal)/i }).first();
  assert.equal(await numericLeaf.count(), 1, "A numeric trigger SME should be available");
  await numericLeaf.evaluate(element => {
    let parent = element.parentElement;
    while (parent) { if (parent.tagName === "DETAILS") parent.open = true; parent = parent.parentElement; }
    element.scrollIntoView({ block: "center" });
  });
  await numericLeaf.click();
  await propertyDialog.screenshot({ path: screenshots.tree });
  const numericTrigger = await numericLeaf.getAttribute("data-property-id");
  await propertyDialog.getByRole("button", { name: "Select SME" }).click();
  await propertyDialog.waitFor({ state: "hidden" });
  assert.equal(await dialog.locator('[data-monitor-property]').first().inputValue(), numericTrigger);
  assert.match(await dialog.locator('[data-monitor-row]').first().textContent(), /xs:(double|float|int|integer|long|decimal)/i);

  await dialog.getByRole("button", { name: "+ Add SME" }).click();
  assert.equal(await dialog.locator("[data-monitor-row]").count(), 2);
  assert.equal(await dialog.locator("[data-condition-row]").count(), 2);
  await dialog.getByRole("button", { name: "Select Monitored SME 2" }).click();
  await propertyDialog.waitFor({ state: "visible" });
  const secondNumericLeaf = propertyDialog.locator('button[data-property-id]').filter({ hasText: /xs:(double|float|int|integer|long|decimal)/i }).nth(1);
  assert.equal(await secondNumericLeaf.count(), 1, "A second numeric SME should be available");
  await secondNumericLeaf.evaluate(element => {
    let parent = element.parentElement;
    while (parent) { if (parent.tagName === "DETAILS") parent.open = true; parent = parent.parentElement; }
  });
  const secondNumericTrigger = await secondNumericLeaf.getAttribute("data-property-id");
  await secondNumericLeaf.click();
  await propertyDialog.getByRole("button", { name: "Select SME" }).click();
  assert.equal(await dialog.locator('[data-monitor-property]').nth(1).inputValue(), secondNumericTrigger);
  await dialog.locator('[name="conditionMode"]').selectOption("AND");
  await dialog.locator('[data-condition-operator]').nth(0).selectOption(">=");
  await dialog.locator('[data-condition-value]').nth(0).fill("0");
  await dialog.locator('[data-condition-operator]').nth(1).selectOption(">=");
  await dialog.locator('[data-condition-value]').nth(1).fill("0");

  await dialog.locator('[name="serviceId"]').selectOption("geometry-correction-service");
  assert.equal(await dialog.locator('[data-params="service"] [data-parameter]').count(), 2, "Service defaultArgs should create two parameter rows");
  assert.equal((await dialog.locator('[data-count="service"]').textContent()).trim(), "2 parameters");
  const firstParameter = dialog.locator('[data-params="service"] [data-parameter]').first();
  await firstParameter.locator("[data-source]").selectOption("property");
  await firstParameter.getByRole("button", { name: "Select Parameter SME" }).click();
  await propertyDialog.waitFor({ state: "visible" });
  await propertyDialog.getByRole("button", { name: "Cancel" }).click();
  await firstParameter.locator("[data-source]").selectOption("constant");
  await dialog.locator('[name="outputKind"]').selectOption("aas_property");
  await dialog.getByRole("button", { name: "Select Output SME" }).click();
  await propertyDialog.waitFor({ state: "visible" });
  await propertyDialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.locator('[name="outputKind"]').selectOption("none");
  await dialog.locator("form").evaluate(element => { element.scrollTop = 0; });
  await dialog.screenshot({ path: screenshots.modal });

  await dialog.locator('[name="serviceId"]').selectOption("energy-monitoring-service");
  assert.equal(await dialog.locator('[data-params="service"] [data-parameter]').count(), 1, "One defaultArg should create one parameter row");
  await dialog.locator('[name="serviceId"]').selectOption("cooling-service");
  assert.equal(await dialog.locator('[data-params="service"] [data-parameter]').count(), 2, "Cooling Service should expose both backend arguments");
  await dialog.locator('[name="outputKind"]').selectOption("aas_property");
  await dialog.getByRole("button", { name: "Select Output SME" }).click();
  await propertyDialog.waitFor({ state: "visible" });
  const outputLeaf = propertyDialog.locator('button[data-property-id]').filter({ hasText: /xs:(double|float|int|integer|long|decimal)/i }).first();
  await outputLeaf.evaluate(element => {
    let parent = element.parentElement;
    while (parent) { if (parent.tagName === "DETAILS") parent.open = true; parent = parent.parentElement; }
  });
  await outputLeaf.click();
  await propertyDialog.getByRole("button", { name: "Select SME" }).click();
  await dialog.getByRole("button", { name: "Save Rule" }).click();
  await dialog.waitFor({ state: "hidden" });

  const card = page.locator('.engine-instance[data-engine-id]').filter({ hasText: "Temperature Guard" });
  await card.waitFor();
  assert.equal(await card.locator(".engine-flow-node").count(), 5);
  assert.match(await card.textContent(), /Monitored SMEs/);
  assert.match(await card.textContent(), /2 SMEs/);
  assert.match(await card.textContent(), /AND/);
  assert.match(await card.textContent(), /Service Trigger/);
  assert.match(await page.locator("#rulesPageCount").textContent(), /1 \/ 1 enabled/);
  assert.match(await page.locator("#overviewRulesCount").textContent(), /1 \/ 1 enabled/);
  await card.getByRole("button", { name: "Run" }).click();
  await page.waitForFunction(() => window.gucAasServiceLinks.snapshot().length === 1 && window.gucAasServiceLinks.state(window.gucAasServiceLinks.snapshot()[0].id).status !== "Running");
  assert.equal(await card.locator(".engine-flow-node.complete").count(), 5);

  const saved = await page.evaluate(() => window.gucAasServiceLinks.snapshot()[0]);
  assert.equal(saved.name, "Temperature Guard");
  assert.equal(saved.monitors.length, 2);
  assert.equal(saved.conditionMode, "AND");
  assert.equal(Object.keys(saved.serviceCall.bindings).length, 2);
  assert.equal(saved.onFalse, "nothing");
  assert.equal(saved.output.kind, "aas_property");
  assert.ok(saved.output.propertyId);

  await card.getByRole("button", { name: "Edit" }).click();
  assert.equal(await dialog.locator('[name="ruleName"]').inputValue(), "Temperature Guard");
  assert.equal(await dialog.locator("[data-monitor-row]").count(), 2);
  await dialog.locator("[data-remove-monitor]").nth(1).click();
  assert.equal(await dialog.locator("[data-monitor-row]").count(), 1);
  await dialog.getByRole("button", { name: "+ Add SME" }).click();
  assert.equal(await dialog.locator("[data-monitor-row]").count(), 2);
  await dialog.getByRole("button", { name: "Close Rule dialog" }).click();
  await card.getByRole("button", { name: "Disable" }).click();
  assert.match(await page.locator("#rulesPageCount").textContent(), /0 \/ 1 enabled/);
  await card.getByRole("button", { name: "Enable" }).click();
  assert.match(await page.locator("#rulesPageCount").textContent(), /1 \/ 1 enabled/);

  const previousRunAt = await page.evaluate(id => window.gucAasServiceLinks.state(id).lastRunAt, saved.id);
  await page.evaluate(propertyId => setDemoAasBindingValue(propertyId, 8), saved.monitors[1].propertyId);
  await page.waitForFunction(({ id, previous }) => window.gucAasServiceLinks.state(id).lastRunAt !== previous, { id: saved.id, previous: previousRunAt });
  assert.equal(await page.evaluate(id => window.gucAasServiceLinks.state(id).status, saved.id), "Success");
  await page.waitForTimeout(1800);

  await page.locator('[data-nav="overview"]').click();
  await page.locator("#overviewRulesList [data-overview-rule-id]").waitFor();
  assert.match(await page.locator("#overviewRulesList").textContent(), /Temperature Guard/);
  await page.screenshot({ path: screenshots.overview, fullPage: true });
  await page.locator("#overviewRulesList [data-overview-rule-id]").click();
  await page.locator("#rulesTab.active").waitFor();
  await page.screenshot({ path: screenshots.desktop, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);

  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  assert.equal(consoleErrors.length, 0, consoleErrors.join("\n"));

  console.log(JSON.stringify({ ok: true, rule: saved.id, screenshots, pageErrors, consoleErrors }, null, 2));
  await browser.close();
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
