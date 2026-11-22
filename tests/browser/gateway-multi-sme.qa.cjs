"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { chromium } = require("playwright");
const BASE_URL = process.env.GUC_QA_BASE_URL || "http://localhost:8090";

const edge = process.env.GUC_BROWSER_EXECUTABLE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const screenshots = {
  gateway: path.join(process.env.TEMP, "guc-gateway-multi-sme.png"),
  aas: path.join(process.env.TEMP, "guc-aas-node-access.png")
};

let qaBrowser;
(async () => {
  const browser = qaBrowser = await chromium.launch({ executablePath: edge, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const pageErrors = [], consoleErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/Failed to load resource.*(502|503)/.test(message.text())) consoleErrors.push(message.text());
  });

  await page.route("**/api/gateway/discover/opcua", async route => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.nodes = (payload.nodes || []).map(node => node.sourceAddress === "ns=2;i=126"
      ? { ...node, readable: true, writable: false, accessLevel: "Read only" }
      : node);
    await route.fulfill({ response, contentType: "application/json", body: JSON.stringify(payload) });
  });

  await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("guc-ui-v0.9-environment", "demo"); });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('[data-nav="gateway"]').click();
  await page.locator("#gatewayTab.active").waitFor();
  const firstMapping = page.locator("#mappingRows .mapping-row").first();
  await firstMapping.waitFor();
  await page.waitForFunction(() => window.gucModel.snapshot().signals.some(signal => signal.targetElement === "cnc-2.ActJogIncrement" && signal.writable === false), null, { timeout: 30000 });
  assert.equal(await page.locator("#gatewayTab").getByText(/Read only|Read \/ Write|Access unknown/).count(), 0, "Gateway tab should not expose OPC UA access labels");

  await firstMapping.getByRole("button", { name: "Link AAS SMEs" }).click();
  const modal = page.locator("#modalBackdrop.open");
  await modal.waitFor();
  await modal.locator("details").evaluateAll(items => items.forEach(item => { item.open = true; }));
  const choices = modal.locator("input[data-link-tree-multi-value]");
  assert.ok(await choices.count() >= 2, "The Link AAS SMEs tree should contain multiple checkbox choices");
  await choices.nth(0).check();
  await choices.nth(1).check();
  assert.equal((await page.locator("#modalSubmit").textContent()).trim(), "Save 2 links");
  await page.locator("#modalSubmit").click();
  await modal.waitFor({ state: "hidden" });

  const managed = await page.evaluate(() => window.gucBindings.snapshot().bindings.filter(item => item.managedBy === "gateway_mapping"));
  assert.equal(managed.length, 2);
  assert.equal(new Set(managed.map(item => item.signalId)).size, 1);
  assert.equal(new Set(managed.map(item => item.propertyId)).size, 2);
  assert.equal(await firstMapping.locator(".binding-link-summary").count(), 2);
  assert.equal(await firstMapping.evaluate(element => element.classList.contains("linked-node")), false, "A Gateway source should not get the blue target border");
  assert.match(await firstMapping.locator(".badge").first().textContent(), /OK · 2 SMEs linked/);

  await firstMapping.getByRole("button", { name: "Link AAS SMEs" }).click();
  await modal.waitFor();
  assert.equal(await modal.locator("input[data-link-tree-multi-value]:checked").count(), 2);
  await page.locator("#modalCancel").click();
  await modal.waitFor({ state: "hidden" });
  await page.locator('[data-nav="aas"]').click();
  await page.locator("#aasTab.active").waitFor();
  await page.locator("#aasDetail .binding-link-summary").first().waitFor();
  assert.equal(await page.locator("#aasDetail .binding-link-summary").count(), 2);
  assert.equal(await page.locator("#aasDetail .binding-link-summary .binding-target").filter({ hasText: "→ AAS" }).count(), 2);
  assert.equal(await page.locator("#aasDetail .aas-tree-node.property.linked-sme").count(), 2);
  assert.equal(await page.locator("#aasDetail .aas-tree-node.property.linked-sme").filter({ hasText: "Linked" }).count(), 2);

  const linkedProperty = page.locator("#aasDetail .aas-tree-node.property").filter({ has: page.locator(".binding-link-summary") }).first();
  const sourcePropertyName = (await linkedProperty.locator(".aas-tree-copy strong").textContent()).trim();
  await linkedProperty.getByRole("button", { name: "Link Gateway" }).click();
  await modal.waitFor();
  const readOnlyChoice = modal.locator("button.link-tree-leaf:disabled").filter({ hasText: "read-only node" });
  assert.ok(await readOnlyChoice.count() >= 1, "Read-only OPC UA nodes should be visible but disabled for AAS to Gateway links");
  assert.match(await readOnlyChoice.first().textContent(), /Read only/);
  await modal.locator("details").evaluateAll(items => items.forEach(item => { item.open = true; }));
  const writableChoice = modal.locator('button.link-tree-leaf:not(:disabled)[data-link-tree-value]:not([data-link-tree-value=""])').filter({ hasText: "cnc-2.ActLoad" }).first();
  const targetSignalName = (await writableChoice.locator("strong").textContent()).trim();
  await writableChoice.click();
  await page.locator("#modalSubmit").click();
  await modal.waitFor({ state: "hidden" });
  const sourceProperty = page.locator("#aasDetail .aas-tree-node.property").filter({ hasText: sourcePropertyName }).first();
  assert.equal(await sourceProperty.evaluate(element => element.classList.contains("linked-sme")), false, "An AAS source should not get the green target border");
  assert.equal(await page.locator("#aasDetail .aas-tree-node.property.linked-sme").count(), 1, "Only the remaining Gateway to AAS target should stay green");
  await page.screenshot({ path: screenshots.aas, fullPage: true });

  await page.locator('[data-nav="gateway"]').click();
  const blueTargets = page.locator("#mappingRows .mapping-row.linked-node");
  assert.equal(await blueTargets.count(), 1, "Only the AAS to Gateway target should be blue");
  assert.match(await blueTargets.first().textContent(), new RegExp(targetSignalName));
  assert.equal(await firstMapping.evaluate(element => element.classList.contains("linked-node")), false, "The Gateway to AAS source should remain unframed");
  await page.screenshot({ path: screenshots.gateway, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);

  console.log(JSON.stringify({ ok: true, bindings: managed.length, screenshots, pageErrors, consoleErrors }, null, 2));
  await browser.close();
})().catch(async error => {
  await qaBrowser?.close();
  console.error(error);
  process.exitCode = 1;
});
