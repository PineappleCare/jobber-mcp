import { WebJournal } from "./storage.js";
import { JobberBrowser } from "./browser.js";
import { WebService } from "./service.js";
import { apiServer, viewerServer } from "./http.js";
import path from "node:path";
const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const key = env("JOBBER_WEB_ENCRYPTION_KEY");
if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error("Invalid web encryption key");
const journal = new WebJournal(
  path.join(env("JOBBER_WEB_STATE_DIR"), "web-operations.db"),
  Buffer.from(key, "hex"),
);
const account = env("JOBBER_WEB_ACCOUNT_ID"),
  browser = new JobberBrowser(journal, account),
  service = new WebService(journal, browser, account);
const api = apiServer(service, env("JOBBER_WEB_SERVICE_KEY"));
const viewer = viewerServer(
  service,
  env("JOBBER_WEB_VIEWER_ORIGIN"),
  env("JOBBER_WEB_VIEWER_OWNER"),
  env("JOBBER_WEB_VIEWER_KEY"),
);
api.listen(3100, "0.0.0.0");
viewer.listen(3101, "0.0.0.0");
async function stop() {
  api.close();
  viewer.close();
  await browser.close();
  journal.close();
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
