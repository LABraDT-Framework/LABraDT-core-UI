"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { chromium } = require("playwright");
const BASE_URL = process.env.GUC_QA_BASE_URL || "http://localhost:8090";

const edge = process.env.GUC_BROWSER_EXECUTABLE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const screenshot = path.join(os.tmpdir(), "guc-v09-backend-aas-live.png");

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: edge });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.addInitScript(() => localStorage.setItem("guc-ui-v0.9-environment", "backend"));
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => /Connected/.test(document.querySelector("#javaEngineBackendStatus")?.textContent || ""));
  await page.waitForFunction(() => document.querySelector("#engineLoadedRuleCount")?.textContent?.trim() === "3");
  await page.waitForFunction(() => /Connected/.test(document.querySelector("#serviceBackendStatus")?.textContent || ""));

  const aasRoundTrip = await page.evaluate(async identifier => {
    const created = await fetch('/api/aas/models/submodels', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id:identifier,idShort:'BrowserQa',modelType:'Submodel',submodelElements:[{modelType:'Property',idShort:'BrowserQaSetpoint',valueType:'xs:double',value:'0'}]})});
    if (!created.ok) throw Error('QA Submodel creation failed: ' + created.status);
    const url = "/api/aas/value?submodelId=" + encodeURIComponent(identifier) + "&idShortPath=BrowserQaSetpoint";
    try {
    const patchResponse = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "12.75"
    });
    const readResponse = await fetch(url);
    return {
      patchStatus: patchResponse.status,
      readStatus: readResponse.status,
      value: await readResponse.json()
    };
    } finally {
      await fetch('/api/aas/models/submodels?identifier=' + encodeURIComponent(identifier), {method:'DELETE'});
    }
  }, 'urn:guc:qa:scalar:' + Date.now());

  assert.deepEqual(aasRoundTrip, { patchStatus: 204, readStatus: 200, value: 12.75 });
  assert.match(await page.locator("#javaEngineBackendStatus").textContent(), /Connected/);
  assert.equal((await page.locator("#engineLoadedRuleCount").textContent()).trim(), "3");
  assert.match(await page.locator("#serviceBackendStatus").textContent(), /Connected/);

  await page.locator('[data-nav="aas"]').click();
  await page.locator("#aasTab.active").waitFor();
  await page.screenshot({ path: screenshot, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  assert.equal(consoleErrors.length, 0, consoleErrors.join("\n"));

  console.log(JSON.stringify({ ok: true, aasRoundTrip, screenshot, pageErrors, consoleErrors }, null, 2));
  await browser.close();
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
