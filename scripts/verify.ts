import { network, run } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Verifies FarmZ + FarmZClaim on Basescan using the addresses recorded by scripts/deploy.ts.
const DEPLOYMENT_FILES: Record<string, string> = {
  baseSepolia: "base-sepolia.json",
  base: "base.json",
};

async function main() {
  const file = DEPLOYMENT_FILES[network.name];
  if (!file) throw new Error(`No deployment file mapping for network "${network.name}"`);
  const deployment = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", file), "utf8"));

  for (const [name, c] of Object.entries<{ address: string; constructorArgs: unknown[] }>(deployment.contracts)) {
    console.log(`Verifying ${name} at ${c.address} ...`);
    try {
      await run("verify:verify", {
        address: c.address,
        constructorArguments: c.constructorArgs,
        contract: `contracts/${name}.sol:${name}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already verified/i.test(msg)) console.log(`${name} already verified.`);
      else throw err;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
