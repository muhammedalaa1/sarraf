import { Store, createApp, reconcilePending } from "./app.js";
import { createPay } from "./pay.js";

const port = Number(process.env.PORT ?? 3000);
const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${port}`;
const { pay, demo } = createPay({ publicUrl });
const store = new Store();

createApp(pay, { store, publicUrl, demo }).listen(port, () => {
  console.log(`Sarraf example shop on http://localhost:${port}${demo ? " (demo mode: fake providers)" : ""}`);
});

setInterval(() => void reconcilePending(pay, store), 5 * 60 * 1000).unref();
