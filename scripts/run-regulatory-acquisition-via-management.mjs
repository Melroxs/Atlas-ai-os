import { spawn } from "node:child_process";

const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
const jurisdictions = process.argv.slice(2).filter(Boolean);
if (jurisdictions.length === 0) jurisdictions.push("FL");
if (!accessToken || !ref) throw new Error("SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required.");
const keyResponse = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
if (!keyResponse.ok) throw new Error(`Unable to retrieve project API keys (${keyResponse.status}).`);
const keys = await keyResponse.json();
const serviceKey = keys.find((key) => key.id === "service_role")?.api_key ?? keys.find((key) => key.type === "secret" && key.secret_jwt_template?.role === "service_role")?.api_key;
if (!serviceKey) throw new Error("No service-role-capable project API key was available.");
const child = spawn("pnpm", ["dlx", "--yes", "tsx", "scripts/acquire-regulatory-wave1.ts", ...jurisdictions], {
  stdio: "inherit",
  env: { ...process.env, SUPABASE_URL: `https://${ref}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: serviceKey },
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
