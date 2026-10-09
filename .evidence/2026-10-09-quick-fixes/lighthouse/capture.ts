// Mobile screenshots of what a visitor sees 300 ms after the HTML arrives
// (session still pending: the stub answers after 750 ms) and once settled.
import { chromium, devices } from "playwright";

const [variant = "head", outDir = "shots"] = process.argv.slice(2);
const browser = await chromium.launch();
const context = await browser.newContext({ ...devices["Pixel 7"] });
for (const page of ["jobs", "login"]) {
  const tab = await context.newPage();
  await tab.goto(`http://localhost:3001/${page}`, { waitUntil: "commit" });
  await tab.waitForTimeout(300);
  await tab.screenshot({ path: `${outDir}/${variant}-${page}-300ms.png` });
  await tab.waitForLoadState("networkidle");
  await tab.waitForTimeout(500);
  await tab.screenshot({ path: `${outDir}/${variant}-${page}-settled.png` });
  await tab.close();
}
await browser.close();
