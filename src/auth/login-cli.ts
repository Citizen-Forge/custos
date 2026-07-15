import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { startOAuthFlow, exchangeCode } from "./oauth.js";
import { saveTokens } from "./credentials.js";

const mode = process.argv.includes("--console") ? "console" : "max";

const flow = startOAuthFlow(mode);

console.log(`\nOpen this URL in your browser and approve access (mode: ${mode}):\n`);
console.log(flow.authorizationUrl);
console.log(`\nAfter approving, copy the code shown on the page (format "code#state") and paste it below.\n`);

const rl = createInterface({ input: stdin, output: stdout });
const pasted = (await rl.question("Paste code here: ")).trim();
rl.close();

const tokens = await exchangeCode(pasted, flow);
await saveTokens(tokens);

console.log("\nLogin successful. Tokens saved to data/credentials.json.");
